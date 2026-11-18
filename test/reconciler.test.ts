import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Reconciler, type FetchPage } from '../src/jobs.js';
import { silentLogger } from '../src/log.js';
import { Metrics } from '../src/metrics.js';
import { call, integration, reconcileUntilClosed, type Stack, startStack } from './harness.js';

describe.skipIf(!integration)('reconciler', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ pagesPerSec: 1000 });
  });
  afterAll(() => s.close());

  const crawl = async (token: string, limit: number) => {
    const r = await call(s.url, 'POST', '/v2/crawl', { token, body: { url: 'https://example.com', limit } });
    expect(r.status).toBe(200);
    return r.json.id as string;
  };
  const events = async (jobId: string) =>
    (await s.pool.query<{ n: number; c: number }>('select count(*)::int as n, coalesce(sum(credits),0)::int as c from usage_events where job_id = $1', [jobId])).rows[0]!;

  it('re-reading a page (crash before the cursor moved) never bills twice', async () => {
    const t = await s.team('replay', null);
    const id = await crawl(t.token, 10);
    await reconcileUntilClosed(s, id);
    const first = await s.used(t.teamId);
    // Reopen and rewind: as if every page were read again.
    await s.pool.query(`update jobs set status = 'open', doc_cursor = 0, billed_docs = 0, rescanned = false, next_check_at = now() where id = $1`, [id]);
    await reconcileUntilClosed(s, id);
    expect(await s.used(t.teamId)).toEqual(first);
    expect((await events(id)).n).toBe(10);
  });

  it('two replicas working the same jobs bill each document once', async () => {
    const t = await s.team('replicas', null);
    const ids = [await crawl(t.token, 20), await crawl(t.token, 20), await crawl(t.token, 20)];
    await new Promise((r) => setTimeout(r, 50));
    const metrics = new Metrics();
    const fetchPage: FetchPage = async (kind, id, skip, limit) => {
      const r = await fetch(`${s.upstreamUrl}/v2/crawl/${id}?skip=${skip}&limit=${limit}`);
      return { httpStatus: r.status, body: await r.json() };
    };
    const mk = () => new Reconciler(s.pool, s.ledger, fetchPage, async () => {}, silentLogger, metrics, { intervalMs: 1, pageSize: 3, maxPagesPerPass: 2 });
    const a = mk();
    const b = mk();
    for (let i = 0; i < 40; i++) {
      await s.pool.query(`update jobs set next_check_at = now() where id = any($1) and status = 'open'`, [ids]);
      await Promise.all([a.runOnce(), b.runOnce()]);
    }
    const { rows } = await s.pool.query(`select status from jobs where id = any($1)`, [ids]);
    expect(rows.every((r) => r.status === 'closed')).toBe(true);
    for (const id of ids) expect(await events(id)).toEqual({ n: 20, c: 28 }); // 20 docs, 4 of them 3-page PDFs: 16 + 12
    expect(await s.used(t.teamId)).toEqual({ used: 84, reserved: 0 });
  });

  it('a replica holding a stale page (lease expired mid-read) cannot move the cursor back', async () => {
    const t = await s.team('stale', null);
    const id = await crawl(t.token, 20);
    await new Promise((r) => setTimeout(r, 50));
    const metrics = new Metrics();
    const real: FetchPage = async (_k, jid, skip, limit) => {
      const r = await fetch(`${s.upstreamUrl}/v2/crawl/${jid}?skip=${skip}&limit=${limit}`);
      return { httpStatus: r.status, body: await r.json() };
    };
    const fast = new Reconciler(s.pool, s.ledger, real, async () => {}, silentLogger, metrics, { intervalMs: 1, pageSize: 8, maxPagesPerPass: 1 });
    // The slow replica reads its page, and before it writes, the fast one claims the job and moves on.
    const slow = new Reconciler(
      s.pool,
      s.ledger,
      async (k, jid, skip, limit) => {
        const page = await real(k, jid, skip, limit);
        await s.pool.query(`update jobs set next_check_at = now() where id = $1`, [jid]);
        await fast.runOnce();
        return page;
      },
      async () => {},
      silentLogger,
      metrics,
      { intervalMs: 1, pageSize: 3, maxPagesPerPass: 1 },
    );
    await s.pool.query(`update jobs set next_check_at = now() where id = $1`, [id]);
    await slow.runOnce();
    const { rows } = await s.pool.query('select doc_cursor, billed_docs from jobs where id = $1', [id]);
    expect(rows[0]).toEqual({ doc_cursor: 8, billed_docs: 8 });
  });

  it('a document that slipped behind the cursor is caught by the end-of-job rescan', async () => {
    const t = await s.team('slip', null);
    const id = await crawl(t.token, 6);
    // Fake Firecrawl that, on the forward pass, hides doc "late" (committed out of finished_at order),
    // then shows it in the right place on a read from 0.
    const all = ['d0', 'd1', 'late', 'd2', 'd3', 'd4'];
    let forward = true;
    const fetchPage: FetchPage = async (_k, _id, skip, limit) => {
      const visible = forward ? all.filter((d) => d !== 'late') : all;
      const data = visible.slice(skip, skip + limit).map((d) => ({ metadata: { scrapeId: d, creditsUsed: d === 'late' ? 7 : 1 } }));
      const end = skip + data.length;
      if (forward && end >= visible.length) forward = false; // by now it has committed
      return { httpStatus: 200, body: { status: 'completed', completed: 6, data, next: end < 6 ? `http://x/v2/crawl/${id}?skip=${end}` : undefined } };
    };
    const r = new Reconciler(s.pool, s.ledger, fetchPage, async () => {}, silentLogger, new Metrics(), { intervalMs: 1, pageSize: 2, maxPagesPerPass: 50 });
    await s.pool.query(`update jobs set next_check_at = now() where id = $1`, [id]);
    await r.runOnce();
    const { rows } = await s.pool.query('select status, rescanned, billed_docs from jobs where id = $1', [id]);
    expect(rows[0]).toMatchObject({ status: 'closed', rescanned: true, billed_docs: 6 });
    expect(await events(id)).toEqual({ n: 6, c: 12 });
  });

  it('cancels a crawl when the team runs out, and still bills what ran', async () => {
    const slow = await startStack({ pagesPerSec: 40 });
    try {
      const t = await slow.team('broke', 8);
      const c = await call(slow.url, 'POST', '/v2/crawl', { token: t.token, body: { url: 'https://example.com', limit: 1000 } });
      const id = c.json.id as string;
      const closed = await reconcileUntilClosed(slow, id, 400);
      expect(closed).toMatchObject({ status: 'closed', close_reason: 'credits_exhausted' });
      const job = slow.mock.jobs.get(id)!;
      expect(job.cancelledAt).not.toBeNull();
      const { used } = await slow.used(t.teamId);
      expect(used).toBeGreaterThanOrEqual(8);
      // Overrun is bounded by what Firecrawl crawls between checks, not by the crawl's limit.
      expect(used).toBeLessThan(40);
      expect((await call(slow.url, 'POST', '/v2/scrape', { token: t.token, body: { url: 'https://e.com' } })).status).toBe(402);
    } finally {
      await slow.close();
    }
  });

  it('closes jobs Firecrawl no longer knows, and counts it as a metering gap', async () => {
    const t = await s.team('gone', null);
    const id = await crawl(t.token, 5);
    s.mock.jobs.delete(id);
    const closed = await reconcileUntilClosed(s, id);
    expect(closed.close_reason).toBe('upstream_gone');
    expect(s.metrics.get('fcgw_metering_gaps_total', { reason: 'upstream_gone' })).toBeGreaterThanOrEqual(1);
  });

  it('backs off when Firecrawl errors, without closing the job', async () => {
    const t = await s.team('flaky', null);
    const id = await crawl(t.token, 5);
    const r = new Reconciler(s.pool, s.ledger, async () => ({ httpStatus: 503, body: {} }), async () => {}, silentLogger, new Metrics(), { intervalMs: 1 });
    await s.pool.query(`update jobs set next_check_at = now() where id = $1`, [id]);
    await r.runOnce();
    const { rows } = await s.pool.query(`select status, failures, next_check_at > now() + interval '2 seconds' as later from jobs where id = $1`, [id]);
    expect(rows[0]).toMatchObject({ status: 'open', failures: 1, later: true });
  });
});
