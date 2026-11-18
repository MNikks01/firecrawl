import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const staticKey = z.object({
  /** The full bearer token callers send. Generate with `admin key:generate`. */
  key: z.string().regex(/^fcgw_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/, 'key must be a fcgw_ token'),
  team: z.string().min(1),
  name: z.string().default('static'),
  /** null or omitted = unlimited. */
  monthlyCredits: z.number().int().nonnegative().nullable().default(null),
  rateMultiplier: z.number().positive().default(1),
});
export type StaticKey = z.infer<typeof staticKey>;

const schema = z.object({
  PORT: z.coerce.number().int().default(3003),
  /** Internal metrics listener. Keep it off the public network. */
  METRICS_PORT: z.coerce.number().int().default(9464),
  /** The self-hosted Firecrawl API. Keep it on a private network: only the gateway should reach it. */
  UPSTREAM_URL: z.url().refine((u) => /^https?:/.test(u), 'http(s) only'),
  /** Optional public origin for URLs Firecrawl returns (crawl `url`, status `next`). Derived from the request when unset. */
  PUBLIC_BASE_URL: z.url().optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  AUTH_PROVIDER: z.enum(['postgres', 'static']).default('postgres'),
  STATIC_KEYS: z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (!s) return [] as StaticKey[];
      try {
        return z.array(staticKey).parse(JSON.parse(s));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'STATIC_KEYS must be a JSON array of {key, team, monthlyCredits?, rateMultiplier?}' });
        return z.NEVER;
      }
    }),
  AUTH_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(30_000),
  /** Requests per minute per team, before the team's multiplier. Bucket size = one minute's worth. */
  RATE_SCRAPE_PER_MIN: z.coerce.number().int().positive().default(100),
  RATE_CRAWL_PER_MIN: z.coerce.number().int().positive().default(15),
  RATE_STATUS_PER_MIN: z.coerce.number().int().positive().default(1500),
  /** What to do when Redis is unreachable. Credits are still enforced by Postgres either way. */
  RATE_LIMIT_FAIL_MODE: z.enum(['open', 'closed']).default('open'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  /** Responses up to this size are buffered so credits and job ids can be read. Larger ones stream through. */
  MAX_BUFFERED_RESPONSE_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  RECONCILER_ENABLED: bool.default(true),
  /** Express `trust proxy`: set when a load balancer terminates TLS in front of the gateway. */
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Compose passes unset variables as empty strings; treat them as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    // Never echo values: some of these are secrets.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.AUTH_PROVIDER === 'static' && cfg.STATIC_KEYS.length === 0) {
    throw new Error('Invalid configuration: AUTH_PROVIDER=static needs STATIC_KEYS');
  }
  return cfg;
}
