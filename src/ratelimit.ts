import type { Redis } from 'ioredis';

/**
 * Token bucket, one per (team, class), kept in a Redis hash and updated by a single Lua script.
 *
 * - Atomic: read, refill, take and write happen in one script, so concurrent gateway
 *   replicas can't both spend the last token.
 * - Uses Redis TIME, not the gateway clock, so replicas with skewed clocks agree.
 * - Capacity = one minute of requests: a team can burst its whole minute, then refills
 *   smoothly. (Firecrawl's own limiter is a fixed window: bursts of 2x at window edges.)
 * - Keys expire once the bucket would be full again, so idle teams cost no memory.
 */
const SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2]) / 60000.0
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
if tokens == nil or ts == nil then
  tokens = cap
  ts = now
end
tokens = math.min(cap, tokens + math.max(0, now - ts) * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
local full = math.ceil((cap - tokens) / rate)
redis.call('PEXPIRE', KEYS[1], full + 1000)
return {allowed, math.floor(tokens), retry, full}
`;

export type RateClass = 'scrape' | 'crawl' | 'status';

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** ms until one token is available (only when denied). */
  retryAfterMs: number;
  /** ms until the bucket is full again. */
  resetMs: number;
  /** true when Redis failed and the fail mode decided. */
  degraded: boolean;
}

export interface RateLimiterOptions {
  perMinute: Record<RateClass, number>;
  failMode: 'open' | 'closed';
  prefix?: string;
}

export class RateLimiter {
  constructor(
    private redis: Redis,
    private opts: RateLimiterOptions,
  ) {
    redis.defineCommand('fcgwTake', { numberOfKeys: 1, lua: SCRIPT });
  }

  capacity(cls: RateClass, multiplier: number): number {
    return Math.max(1, Math.floor(this.opts.perMinute[cls] * multiplier));
  }

  async take(teamId: string, cls: RateClass, multiplier: number): Promise<RateDecision> {
    const limit = this.capacity(cls, multiplier);
    try {
      const r = (await (this.redis as unknown as {
        fcgwTake(key: string, cap: number, perMin: number): Promise<[number, number, number, number]>;
      }).fcgwTake(`${this.opts.prefix ?? 'fcgw'}:rl:${cls}:${teamId}`, limit, limit)) as [number, number, number, number];
      return { allowed: r[0] === 1, limit, remaining: r[1], retryAfterMs: r[2], resetMs: r[3], degraded: false };
    } catch {
      const allowed = this.opts.failMode === 'open';
      return { allowed, limit, remaining: allowed ? limit : 0, retryAfterMs: allowed ? 0 : 1000, resetMs: 0, degraded: true };
    }
  }
}

/** IETF draft-ietf-httpapi-ratelimit-headers (draft 08+) plus the classic Retry-After. */
export function rateLimitHeaders(cls: RateClass, d: RateDecision): Record<string, string> {
  if (d.degraded) return {};
  const h: Record<string, string> = {
    'RateLimit-Policy': `"${cls}";q=${d.limit};w=60`,
    RateLimit: `"${cls}";r=${d.remaining};t=${Math.ceil(d.resetMs / 1000)}`,
  };
  if (!d.allowed) h['Retry-After'] = String(Math.max(1, Math.ceil(d.retryAfterMs / 1000)));
  return h;
}
