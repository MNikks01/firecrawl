import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticAuthProvider } from '../src/auth/static.js';
import { createPool, migrate } from '../src/db.js';
import { generateKey } from '../src/keys.js';
import { Ledger } from '../src/ledger.js';
import { RateLimiter } from '../src/ratelimit.js';
import { connectRedis, freshDatabase, integration } from './harness.js';
import type { Redis } from 'ioredis';
import type pg from 'pg';

describe.skipIf(!integration)('token bucket (real Redis)', () => {
  let redis: Redis;
  beforeAll(async () => {
    redis = await connectRedis();
  });
  afterAll(() => redis.disconnect());

  const limiter = (perMin: number, failMode: 'open' | 'closed' = 'open', r?: Redis) =>
    new RateLimiter(r ?? redis, { perMinute: { scrape: perMin, crawl: perMin, status: perMin }, failMode, prefix: `t:${randomUUID()}` });

  it('admits exactly the bucket, then 429s with a retry hint', async () => {
    const l = limiter(10);
    const results = await Promise.all(Array.from({ length: 25 }, () => l.take('team', 'scrape', 1)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    const denied = results.find((r) => !r.allowed)!;
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(6_000); // 10/min = one token per 6s
  });

  it('refills continuously', async () => {
    const l = limiter(120); // 2 per second
    const burst = await Promise.all(Array.from({ length: 130 }, () => l.take('t', 'scrape', 1)));
    expect(burst.filter((r) => r.allowed)).toHaveLength(120);
    await new Promise((r) => setTimeout(r, 1_100)); // ~2.2 tokens
    const after = await Promise.all(Array.from({ length: 10 }, () => l.take('t', 'scrape', 1)));
    expect(after.filter((r) => r.allowed)).toHaveLength(2);
  });

  it('keeps teams and classes apart, and scales by multiplier', async () => {
    const l = limiter(3);
    for (let i = 0; i < 3; i++) await l.take('a', 'scrape', 1);
    expect((await l.take('a', 'scrape', 1)).allowed).toBe(false);
    expect((await l.take('b', 'scrape', 1)).allowed).toBe(true);
    expect((await l.take('a', 'status', 1)).allowed).toBe(true);
    const big = await Promise.all(Array.from({ length: 12 }, () => l.take('c', 'scrape', 3)));
    expect(big.filter((r) => r.allowed)).toHaveLength(9);
  });

  it('fails open or closed when Redis is gone, without hanging', async () => {
    const dead = await connectRedis();
    dead.disconnect();
    const t0 = Date.now();
    const open = await limiter(5, 'open', dead).take('x', 'scrape', 1);
    const closed = await limiter(5, 'closed', dead).take('x', 'scrape', 1);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(open).toMatchObject({ allowed: true, degraded: true });
    expect(closed).toMatchObject({ allowed: false, degraded: true });
  });
});

describe.skipIf(!integration)('ledger (real Postgres)', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let ledger: Ledger;
  const team = async (credits: number | null) =>
    (await pool.query<{ id: string }>('insert into teams (name, monthly_credits) values ($1, $2) returning id', [randomUUID(), credits])).rows[0]!.id;

  beforeAll(async () => {
    const db = await freshDatabase();
    drop = db.drop;
    pool = createPool(db.url, 30);
    await migrate(pool);
    ledger = new Ledger(pool);
  });
  afterAll(async () => {
    await pool.end();
    await drop();
  });

  it('never over-commits a team under concurrent reservations', async () => {
    const t = await team(20);
    const results = await Promise.all(Array.from({ length: 60 }, () => ledger.reserve(t, 1, randomUUID(), 60_000)));
    expect(results.filter((r) => r.ok)).toHaveLength(20);
    expect((await ledger.balance(t)).reserved).toBe(20);
  });

  it('settles at the actual amount and releases the hold; a second settle is a no-op', async () => {
    const t = await team(100);
    const id = randomUUID();
    await ledger.reserve(t, 10, id, 60_000);
    const ev = { idempotencyKey: `req:${id}`, teamId: t, keyId: null, endpoint: 'scrape', credits: 3 };
    await ledger.settle(id, ev);
    await ledger.settle(id, ev);
    expect(await ledger.balance(t)).toMatchObject({ used: 3, reserved: 0, remaining: 97 });
    const { rows } = await pool.query('select count(*)::int as n from usage_events where team_id = $1', [t]);
    expect(rows[0].n).toBe(1);
  });

  it('a failed request settles at 0 and writes no event', async () => {
    const t = await team(10);
    const id = randomUUID();
    await ledger.reserve(t, 5, id, 60_000);
    await ledger.settle(id, { idempotencyKey: `req:${id}`, teamId: t, keyId: null, endpoint: 'scrape', credits: 0 });
    expect(await ledger.balance(t)).toMatchObject({ used: 0, reserved: 0, remaining: 10 });
  });

  it('refuses when the hold does not fit and reports what is left', async () => {
    const t = await team(10);
    expect(await ledger.reserve(t, 8, randomUUID(), 60_000)).toEqual({ ok: true });
    expect(await ledger.reserve(t, 5, randomUUID(), 60_000)).toEqual({ ok: false, remaining: 2 });
  });

  it('unlimited teams always reserve, and usage is still recorded', async () => {
    const t = await team(null);
    const id = randomUUID();
    expect((await ledger.reserve(t, 1_000_000, id, 60_000)).ok).toBe(true);
    await ledger.settle(id, { idempotencyKey: `req:${id}`, teamId: t, keyId: null, endpoint: 'scrape', credits: 7 });
    expect(await ledger.balance(t)).toMatchObject({ limit: null, used: 7, remaining: null });
  });

  it('static keys: teams are upserted so metering works, and only listed keys pass', async () => {
    const k = generateKey().token;
    const name = `static-${randomUUID()}`;
    const p = await StaticAuthProvider.create(pool, [{ key: k, team: name, name: 'cfg', monthlyCredits: 42, rateMultiplier: 2 }]);
    const who = await p.authenticate(k);
    expect(who).toMatchObject({ teamName: name, rateMultiplier: 2 });
    expect(await p.authenticate(generateKey().token)).toBeNull();
    expect(await p.authenticate(k.slice(0, -1) + (k.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect((await ledger.balance(who!.teamId)).limit).toBe(42);
    // A redeploy with a new limit updates the same team.
    await StaticAuthProvider.create(pool, [{ key: k, team: name, name: 'cfg', monthlyCredits: 100, rateMultiplier: 1 }]);
    expect((await ledger.balance(who!.teamId)).limit).toBe(100);
  });

  it('releases holds a crashed request left behind; a late settle still charges once', async () => {
    const t = await team(10);
    const id = randomUUID();
    await ledger.reserve(t, 6, id, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await ledger.sweepExpired()).toBeGreaterThanOrEqual(6);
    expect(await ledger.balance(t)).toMatchObject({ reserved: 0, used: 0 });
    await ledger.settle(id, { idempotencyKey: `req:${id}`, teamId: t, keyId: null, endpoint: 'scrape', credits: 2 });
    expect(await ledger.balance(t)).toMatchObject({ reserved: 0, used: 2 });
  });
});
