import { Redis } from 'ioredis';
import type pg from 'pg';
import { createApp } from './app.js';
import { PostgresAuthProvider } from './auth/postgres.js';
import { StaticAuthProvider } from './auth/static.js';
import type { AuthProvider } from './auth/types.js';
import type { Config } from './config.js';
import { createPool, migrate } from './db.js';
import { JOB_PATH, JobRegistry, Reconciler, type ReconcilerOptions } from './jobs.js';
import { Ledger } from './ledger.js';
import type { Logger } from './log.js';
import { Metrics } from './metrics.js';
import { Upstream } from './proxy.js';
import { RateLimiter } from './ratelimit.js';

export const INVALIDATE_CHANNEL = 'fcgw:auth:invalidate';

/** The reconciler's two upstream calls: read a page of a job's documents, and cancel a job. */
export function reconcilerFor(pool: pg.Pool, ledger: Ledger, upstream: Upstream, log: Logger, metrics: Metrics, opts: ReconcilerOptions): Reconciler {
  return new Reconciler(
    pool,
    ledger,
    async (kind, id, skip, limit) => {
      const r = await upstream.send({ method: 'GET', pathAndQuery: `${JOB_PATH[kind]}${id}?skip=${skip}&limit=${limit}`, headers: {}, requestId: `reconcile-${id}` });
      if (r.kind === 'stream') {
        r.stream.destroy();
        throw new Error('status page larger than MAX_BUFFERED_RESPONSE_BYTES');
      }
      return { httpStatus: r.status, body: r.json };
    },
    async (kind, id) => {
      const r = await upstream.send({ method: 'DELETE', pathAndQuery: `${JOB_PATH[kind]}${id}`, headers: {}, requestId: `reconcile-${id}` });
      if (r.kind === 'stream') r.stream.destroy();
      if (r.status >= 400 && r.status !== 404) throw new Error(`cancel returned ${r.status}`);
    },
    log,
    metrics,
    opts,
  );
}

export interface Gateway {
  app: ReturnType<typeof createApp>;
  metrics: Metrics;
  pool: pg.Pool;
  redis: Redis;
  reconciler: Reconciler;
  close(): Promise<void>;
}

export async function buildGateway(cfg: Config, log: Logger): Promise<Gateway> {
  const pool = createPool(cfg.DATABASE_URL);
  const applied = await migrate(pool);
  if (applied.length) log.info('migrations applied', { applied });

  // Rate limiting must not hang a request when Redis is down: fail fast, let the fail mode decide.
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000, lazyConnect: true });
  redis.on('error', (err) => log.warn('redis error', { err }));
  // Don't start serving with a cold connection (every early request would hit the fail mode).
  // Don't refuse to start either: Redis down is a degraded mode, not a fatal one.
  await redis.connect().catch((err) => log.warn('redis unavailable at startup; rate limiting degraded', { err, failMode: cfg.RATE_LIMIT_FAIL_MODE }));

  const metrics = new Metrics();
  let auth: AuthProvider;
  let sub: Redis | null = null;
  if (cfg.AUTH_PROVIDER === 'static') {
    auth = await StaticAuthProvider.create(pool, cfg.STATIC_KEYS);
  } else {
    const pgAuth = new PostgresAuthProvider(pool, cfg.AUTH_CACHE_TTL_MS);
    auth = pgAuth;
    // Revocations from `admin key:revoke` reach every replica immediately.
    sub = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
    sub.on('error', (err) => log.warn('redis subscriber error', { err }));
    await sub.subscribe(INVALIDATE_CHANNEL).catch((err) => log.warn('could not subscribe to key revocations; relying on cache TTL', { err }));
    sub.on('message', (_ch, keyId) => pgAuth.invalidate(String(keyId)));
  }

  const ledger = new Ledger(pool);
  const jobs = new JobRegistry(pool);
  const upstream = new Upstream(cfg.UPSTREAM_URL, cfg.UPSTREAM_TIMEOUT_MS, cfg.MAX_BUFFERED_RESPONSE_BYTES);
  const limiter = new RateLimiter(redis, {
    perMinute: { scrape: cfg.RATE_SCRAPE_PER_MIN, crawl: cfg.RATE_CRAWL_PER_MIN, status: cfg.RATE_STATUS_PER_MIN },
    failMode: cfg.RATE_LIMIT_FAIL_MODE,
  });

  const reconciler = reconcilerFor(pool, ledger, upstream, log, metrics, { intervalMs: cfg.RECONCILE_INTERVAL_MS });

  const app = createApp({
    auth,
    limiter,
    ledger,
    jobs,
    upstream,
    log,
    metrics,
    publicBaseUrl: cfg.PUBLIC_BASE_URL,
    trustProxy: cfg.TRUST_PROXY,
    maxRequestBytes: cfg.MAX_REQUEST_BYTES,
    reservationTtlMs: cfg.UPSTREAM_TIMEOUT_MS + 60_000,
    ready: async () => {
      await pool.query('select 1');
      // Redis is not required for readiness when failing open.
      if (cfg.RATE_LIMIT_FAIL_MODE === 'closed') await redis.ping();
    },
  });

  return {
    app,
    metrics,
    pool,
    redis,
    reconciler,
    async close() {
      await reconciler.stop();
      sub?.disconnect();
      redis.disconnect();
      await pool.end();
    },
  };
}
