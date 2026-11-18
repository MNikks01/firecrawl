import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import pg from 'pg';
import { createMock, type MockState } from '../mock/firecrawl-mock.js';
import { createApp } from '../src/app.js';
import { PostgresAuthProvider } from '../src/auth/postgres.js';
import { createPool, migrate } from '../src/db.js';
import { JobRegistry, type Reconciler } from '../src/jobs.js';
import { generateKey } from '../src/keys.js';
import { Ledger } from '../src/ledger.js';
import { silentLogger } from '../src/log.js';
import { Metrics } from '../src/metrics.js';
import { Upstream } from '../src/proxy.js';
import { type RateClass, RateLimiter } from '../src/ratelimit.js';
import { reconcilerFor } from '../src/wiring.js';

/**
 * Integration tests run against a real Postgres and Redis:
 *   TEST_DATABASE_URL  a role that may CREATE DATABASE (each run gets its own, dropped after)
 *   TEST_REDIS_URL
 * Without them, the integration suites are skipped and only unit tests run.
 */
export const PG_ADMIN = process.env.TEST_DATABASE_URL;
export const REDIS_URL = process.env.TEST_REDIS_URL;
export const integration = Boolean(PG_ADMIN && REDIS_URL);

export async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `fcgw_test_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: PG_ADMIN });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const u = new URL(PG_ADMIN!);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: async () => {
      const a = new pg.Client({ connectionString: PG_ADMIN });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export async function connectRedis(url = REDIS_URL!): Promise<Redis> {
  const r = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  await r.connect();
  return r;
}

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

export interface Stack {
  url: string;
  upstreamUrl: string;
  mock: MockState;
  pool: pg.Pool;
  redis: Redis;
  ledger: Ledger;
  metrics: Metrics;
  auth: PostgresAuthProvider;
  reconciler: Reconciler;
  team(name: string, monthlyCredits: number | null, rateMultiplier?: number): Promise<{ teamId: string; token: string; keyId: string }>;
  used(teamId: string): Promise<{ used: number; reserved: number }>;
  close(): Promise<void>;
}

export async function startStack(
  o: {
    rate?: Partial<Record<RateClass, number>>;
    failMode?: 'open' | 'closed';
    redis?: Redis;
    pagesPerSec?: number;
    authTtlMs?: number;
    upstreamUrl?: string;
    upstreamTimeoutMs?: number;
    pageSize?: number;
  } = {},
): Promise<Stack> {
  const db = await freshDatabase();
  const pool = createPool(db.url, 20);
  await migrate(pool);
  const redis = o.redis ?? (await connectRedis());
  const prefix = `fcgwtest:${randomBytes(4).toString('hex')}`;

  const { app: mockApp, state: mock } = createMock({ pagesPerSec: o.pagesPerSec ?? 1000, keepRequests: true });
  const up = await listen(mockApp);
  const upstreamUrl = o.upstreamUrl ?? up.url;

  const metrics = new Metrics();
  const ledger = new Ledger(pool);
  const auth = new PostgresAuthProvider(pool, o.authTtlMs ?? 30_000);
  const upstream = new Upstream(upstreamUrl, o.upstreamTimeoutMs ?? 5_000, 64 * 1024 * 1024);
  const limiter = new RateLimiter(redis, {
    perMinute: { scrape: 100_000, crawl: 100_000, status: 100_000, ...o.rate },
    failMode: o.failMode ?? 'open',
    prefix,
  });
  const app = createApp({
    auth,
    limiter,
    ledger,
    jobs: new JobRegistry(pool),
    upstream,
    log: silentLogger,
    metrics,
    trustProxy: 0,
    maxRequestBytes: 1024 * 1024,
    reservationTtlMs: 60_000,
    ready: async () => {
      await pool.query('select 1');
    },
  });
  const gw = await listen(app);
  const reconciler = reconcilerFor(pool, ledger, upstream, silentLogger, metrics, { intervalMs: 20, pageSize: o.pageSize ?? 5, maxPagesPerPass: 50 });

  return {
    url: gw.url,
    upstreamUrl,
    mock,
    pool,
    redis,
    ledger,
    metrics,
    auth,
    reconciler,
    async team(name, monthlyCredits, rateMultiplier = 1) {
      const t = await pool.query<{ id: string }>('insert into teams (name, monthly_credits, rate_multiplier) values ($1, $2, $3) returning id', [
        name,
        monthlyCredits,
        rateMultiplier,
      ]);
      const k = generateKey();
      await pool.query('insert into api_keys (id, team_id, name, secret_hash) values ($1, $2, $3, $4)', [k.id, t.rows[0]!.id, 'test', k.secretHash]);
      return { teamId: t.rows[0]!.id, token: k.token, keyId: k.id };
    },
    async used(teamId) {
      const b = await ledger.balance(teamId);
      return { used: b.used, reserved: b.reserved };
    },
    async close() {
      await reconciler.stop();
      await new Promise((r) => gw.server.close(r));
      gw.server.closeAllConnections?.();
      await new Promise((r) => up.server.close(r));
      up.server.closeAllConnections?.();
      const keys = await redis.keys(`${prefix}:*`).catch(() => []);
      if (keys.length) await redis.del(...keys).catch(() => {});
      if (!o.redis) redis.disconnect();
      await pool.end();
      await db.drop();
    },
  };
}

export async function call(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json };
}

/** Run the reconciler until the job closes (or give up). */
export async function reconcileUntilClosed(s: Stack, jobId: string, maxPasses = 200): Promise<{ status: string; close_reason: string | null }> {
  for (let i = 0; i < maxPasses; i++) {
    await s.pool.query(`update jobs set next_check_at = now() where id = $1 and status = 'open'`, [jobId]);
    await s.reconciler.runOnce();
    const { rows } = await s.pool.query<{ status: string; close_reason: string | null }>('select status, close_reason from jobs where id = $1', [jobId]);
    if (rows[0]?.status === 'closed') return rows[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${jobId} did not close`);
}
