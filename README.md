# Firecrawl self-host gateway: API keys, rate limits, credit metering

Self-hosted Firecrawl has no auth layer of its own. [SELF_HOST.md](https://github.com/firecrawl/firecrawl/blob/25c130276117f3d6fe5e142147cc2414d6dee609/SELF_HOST.md#L54-L56) says the default API is unauthenticated, and tells you to add "a complete authentication design" before it leaves a trusted network. The cloud's auth and billing (Supabase, Autumn, Bigtable/ClickHouse) can't be configured self-hosted. This is that design: a gateway in front of an unmodified Firecrawl.

## What self-hosted Firecrawl does today (commit `25c1302`, 2026-11-18)

- **Every caller is the same team.** With `USE_DB_AUTHENTICATION=false`, `withAuth` returns a mock ([withAuth.ts:15](https://github.com/firecrawl/firecrawl/blob/25c130276117f3d6fe5e142147cc2414d6dee609/apps/api/src/lib/withAuth.ts#L15)) whose team is `"bypass"` ([auth.ts:185](https://github.com/firecrawl/firecrawl/blob/25c130276117f3d6fe5e142147cc2414d6dee609/apps/api/src/controllers/auth.ts#L185)). The rate limiter lives inside the bypassed function.
- **So any caller can read or cancel any job.** The crawl-status ownership check compares `sc.team_id` with the caller's team ([crawl-status.ts:188](https://github.com/firecrawl/firecrawl/blob/25c130276117f3d6fe5e142147cc2414d6dee609/apps/api/src/controllers/v2/crawl-status.ts#L188)), and both are `"bypass"`. `/v2/crawl/active` lists everyone's crawls. Batch scrape's `appendToId` lets one caller add URLs to another's job.
- **Credits are computed, then thrown away.** The worker prices every page into `doc.metadata.creditsUsed` ([scrape-worker.ts:863](https://github.com/firecrawl/firecrawl/blob/25c130276117f3d6fe5e142147cc2414d6dee609/apps/api/src/services/worker/scrape-worker.ts#L863)). `billTeam` is wrapped in the same bypass ([credit_billing.ts:26](https://github.com/firecrawl/firecrawl/blob/25c130276117f3d6fe5e142147cc2414d6dee609/apps/api/src/services/billing/credit_billing.ts#L26)). Crawl status reports `creditsUsed: -1` ([crawl-status.ts:238](https://github.com/firecrawl/firecrawl/blob/25c130276117f3d6fe5e142147cc2414d6dee609/apps/api/src/controllers/v2/crawl-status.ts#L238)), because the total is read from Bigtable or ClickHouse.

## What the gateway adds

| | |
|---|---|
| **API keys** | Per team, `fcgw_<id>_<secret>`. Only `sha256(secret)` is stored. Two providers behind one interface: Postgres (create/revoke with the admin CLI) or static keys from config. Revocation reaches every replica immediately over Redis pub/sub. |
| **Isolation** | The gateway records which team created each job. Other teams get the same `404` as for a made-up id. Routes are deny-by-default: v2 scrape, map, search, crawl and batch scrape are open. Everything else returns 404, including `/admin/*`, v1, `/crawl/active` and `/team/*`. |
| **Rate limits** | A token bucket per team per class (scrape, crawl, status), in one Redis Lua script on Redis's clock. Responses carry `RateLimit-Policy`/`RateLimit` (IETF draft) headers, and `Retry-After` on 429. |
| **Credits** | A monthly limit per team, in Postgres. Sync requests reserve before calling Firecrawl and settle at what Firecrawl reports, so a request over the limit gets `402`. Crawls and batch scrapes are billed per document by a reconciler and cancelled when the team runs out. |
| **SDK compatibility** | Point any Firecrawl SDK's `apiUrl` at the gateway. Crawl `url` and pagination `next` links are rewritten to the gateway's address (Firecrawl builds them from its internal Host). `GET /v2/team/credit-usage` answers in Firecrawl's shape. |

```
client ──Bearer fcgw_…──▶ gateway :3003 ──(private network, no auth)──▶ Firecrawl api:3002
                           │      │                                          ▲
                        Redis  Postgres ◀── reconciler (in-process) ── reads job documents
                      (buckets) (keys, teams, credits, jobs, usage ledger)
```

## Run it

```bash
cp .env.example .env
sed -i.bak "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
docker compose --profile mock up -d --build            # against the bundled fake Firecrawl
alias admin='docker compose exec gateway node dist/src/bin/admin.js'
admin team:create acme --monthly-credits 50000
KEY=$(admin key:create acme --name ci)                 # shown once
curl -s -X POST localhost:3003/v2/scrape -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"url":"https://example.com"}'
admin usage acme
admin key:revoke <key-id>
```

**Against a real Firecrawl.** Start Firecrawl with `firecrawl.override.yml`; it stops publishing the unauthenticated API on host port 3002, so the gateway is the only way in. Then run `docker compose -f docker-compose.yml -f compose.firecrawl.yml up -d --build`.

**Static keys instead of the database.** Set `AUTH_PROVIDER=static` and `STATIC_KEYS=[{"key":"fcgw_…","team":"acme","monthlyCredits":50000}]`, generating keys with `admin key:generate`. Teams are upserted at startup.

## Verification

**Tests:** `npm test` runs 50 tests. 35 of them run against real Postgres and Redis (`TEST_DATABASE_URL`, `TEST_REDIS_URL`), and are skipped without them. I ran them on Postgres 16 and Redis 7; the CI config in `ci/` uses Postgres 17.

**Mutation checks:** 12 deliberate breaks, each caught by a failing test:
- no ownership check, and no `appendToId` check;
- skipping the secret comparison;
- forwarding the caller's key upstream;
- reserving without the limit;
- non-idempotent settle, and non-idempotent document charges;
- no end-of-job rescan;
- no cursor check between replicas;
- routing on the raw path;
- the first-of-month race;
- no link rewriting.

**A real bug the tests caught:** concurrent first requests of a month falsely got 402. The racer whose period-row insert lost read "row exists" as "over limit". It hit unlimited teams too.

**End to end (built binaries, separate processes).** These steps ran in order:
1. A JSON scrape cost 5 credits.
2. A 10-page crawl was billed 14 credits without the client polling: two of its pages are 3-page PDFs, which an estimate would have priced at 1.
3. The 20-credit limit was then enforced with 402s.
4. `/admin/queues` returned 404 through the gateway and 200 straight to Firecrawl.
5. A revoked key got 401 on the next request, with a 30 s auth cache in place.

**Load (`load/gateway.k6.js`, k6 2.3.0)**, at 200 req/s against the mock, which adds a fixed 50 ms. Two runs:

| added by the gateway | MacBook M2, Docker (mock 50 ms) | 2-core sandbox, everything co-located (mock 5 ms) |
|---|---|---|
| p50 | +1.0 ms | +3.0 ms |
| p95 | +1.1 ms | +7.5 ms |
| p99 | not meaningful (see note) | +18.6 ms |

The M2 run's p99 came out negative (direct 72.9 ms, gateway 58.6 ms). That's the direct scenario paying cold start by running first, not a gateway speedup. The script now warms both paths for 5 s before measuring.

- **Rate limit (both runs):** 149 admitted at 20 req/s for 30 s, against an expected 150 (bucket 100 + refill 50). Every other request got a clean 429.
- **Quota (both runs):** 50 concurrent clients spent exactly 300 of 300 credits; every other request got 402 (45,924 on the M2).
- **Errors:** 0 unexpected responses in both runs.
- **Settle change (sandbox):** making settle a single statement (one round trip instead of five) cut the added p95 from +12.3 ms and the added p99 from +50.7 ms.

Run it yourself with `docker compose --profile mock --profile load run --rm k6`. Results go to `load/results/summary.md`.

## Trade-offs that matter

- **A gateway in front, not a patch inside Firecrawl.**
  - *For:* works with any Firecrawl release and needs nothing merged upstream.
  - *Against:* it has to infer from responses what Firecrawl knows internally.
  - *The upstream fix:* a self-host provider at the `withAuth`/`authenticateUser` seam, giving each key a real team, plus a local `billTeam` ledger. That would remove most of the reconciler. The gateway's middleware (`resolveRoute`, `authenticate`, `rateLimit`) is plain Express, so it can mount in Firecrawl's app as a first step.
- **Crawls are billed by reading every document a second time.**
  - *Why:* Firecrawl reports no usable job total self-hosted, so the reconciler reads each job's completed documents, in Firecrawl's order (`finished_at, created_at, id`), from a forward `?skip=` cursor. It charges each document's own `creditsUsed`, keyed by `scrapeId`.
  - *Why not cheaper options:*
    - *Estimating from page count:* misprices PDFs and `deterministicJson`.
    - *Webhooks:* Firecrawl refuses private webhook targets unless `ALLOW_LOCAL_WEBHOOKS=true`. That flag also turns off the scraper's private-IP guard ([safeFetch.ts:55](https://github.com/firecrawl/firecrawl/blob/25c130276117f3d6fe5e142147cc2414d6dee609/apps/api/src/scraper/scrapeURL/engines/utils/safeFetch.ts#L55), [:130](https://github.com/firecrawl/firecrawl/blob/25c130276117f3d6fe5e142147cc2414d6dee609/apps/api/src/scraper/scrapeURL/engines/utils/safeFetch.ts#L130)), opening an SSRF path to the network the gateway, Postgres and Redis share. **Don't set it.**
  - *Cost:* every document crosses the private network twice.
  - *Correctness:*
    - Two workers can commit out of `finished_at` order, which can slip a document behind the cursor. So at job end, billed documents are compared with Firecrawl's `completed` count, with one rescan on a mismatch. `scrapeId` makes re-reads free.
    - Results expire after 24 h. A job not fully read by then is closed, and counted in `fcgw_metering_gaps_total`.
- **Quota is hard for sync requests and soft for crawls.**
  - *Sync:* a scrape that doesn't fit its hold gets 402 before Firecrawl is called.
  - *Crawls:* a crawl that starts under the limit is cancelled once the team runs out. The overrun is bounded by what Firecrawl crawls in one reconcile interval (`RECONCILE_INTERVAL_MS`, 5 s by default), so roughly pages/s × 5 s × price per page. In the test (40 pages/s, 20 ms interval) the team stopped at exactly its 8-credit limit.
  - *Why not hold `limit × price` up front:* `limit` defaults to 10,000. It's a ceiling, not an estimate, so holding it would refuse almost every crawl.
- **Settle failure means unbilled, not failed.** If Postgres can't record a charge, the caller still gets their result: the work is done. The hold expires and the sweeper releases it. `fcgw_settle_failures_total` is the counter to alert on.
- **Rate limiting fails open by default.** With Redis down, requests are served unlimited (logged, counted). Credits are still enforced by Postgres. Set `RATE_LIMIT_FAIL_MODE=closed` if Firecrawl is the fragile part. The Redis client fails fast, so neither mode adds a hang.
- **The bucket holds one minute's worth of requests.** Teams can burst their whole minute, then refill smoothly. Firecrawl's own limiter is a fixed window, which allows a 2× burst at window edges. Limits are per team, scaled by the team's `rate_multiplier`, like Firecrawl's plans.
- **Fast hash, cached, with push revocation.** Keys carry 256 random bits, so bcrypt would only add latency. Lookups are cached for 30 s per replica, and `admin key:revoke` pushes invalidation over Redis. Without Redis, revocation lag is the cache TTL.

## Not built / not verified

- **Not run against a live Firecrawl.** The mock mirrors the v2 shapes read in source at `25c1302`. Run one session with `compose.firecrawl.yml`, including a crawl, to confirm the documents carry `scrapeId` and `creditsUsed` as the code says. The FoundationDB queue backend's document order was not checked; only the Postgres backend's was.
- **No per-team concurrency cap.** All teams still share Firecrawl's one concurrency pool, so one team's large crawl can delay others. A cap needs an atomic slot reservation before job creation.
- **Endpoints closed through the gateway:**
  - v1, extract, agent, monitors and websockets;
  - `/v2/crawl/active`, which the gateway could serve from its own job table.
- **Map is billed at 1 credit**, since Firecrawl doesn't report a figure for it.
- **Dev-only advisory:** `npm audit` flags picomatch ≤4.0.7 (ReDoS) through vitest, with no fixed version available. Production dependencies are clean.
