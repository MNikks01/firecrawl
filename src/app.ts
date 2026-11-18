import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AuthProvider, Principal } from './auth/types.js';
import { bearer } from './keys.js';
import type { Ledger } from './ledger.js';
import type { Logger } from './log.js';
import type { Metrics } from './metrics.js';
import { reportedCredits, scrapeCredits, searchCredits } from './pricing.js';
import { rewriteUrls, type Upstream, UpstreamError, type UpstreamResponse } from './proxy.js';
import { rateLimitHeaders, type RateLimiter } from './ratelimit.js';
import { matchRoute, type Route } from './routes.js';
import { JOB_PATH, type JobRegistry } from './jobs.js';

export interface GatewayDeps {
  auth: AuthProvider;
  limiter: RateLimiter;
  ledger: Ledger;
  jobs: JobRegistry;
  upstream: Upstream;
  log: Logger;
  metrics: Metrics;
  publicBaseUrl?: string;
  trustProxy: number;
  maxRequestBytes: number;
  reservationTtlMs: number;
  ready?: () => Promise<void>;
}

interface Locals {
  requestId: string;
  route: Route;
  path: string;
  principal: Principal;
  startedAt: number;
}

const fail = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ success: false, error, ...extra });

// ---------------------------------------------------------------------------------------------
// Middleware. Each piece is a plain Express middleware, so it can also be mounted in front of
// Firecrawl's own routes (see README, "Upstreaming").
// ---------------------------------------------------------------------------------------------

/** Default-deny route table. Sets res.locals.route or answers 404. */
export function resolveRoute() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Normalize the way a URL parser would (dot segments, duplicate slashes are not collapsed),
    // and forward exactly the path we validated.
    const u = new URL(req.originalUrl, 'http://gateway.invalid');
    const route = matchRoute(req.method, u.pathname);
    if (!route) return fail(res, 404, 'Not found. This gateway exposes Firecrawl v2 scrape, map, search, crawl and batch scrape.');
    res.locals.route = route;
    res.locals.path = u.pathname + u.search;
    next();
  };
}

export function authenticate(provider: AuthProvider, metrics: Metrics, log: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req.headers.authorization);
    if (!token) {
      metrics.inc('fcgw_auth_failures_total', { reason: 'missing' }, 1, 'Rejected credentials');
      return fail(res, 401, 'Unauthorized: missing Bearer token');
    }
    provider.authenticate(token).then(
      (p) => {
        if (!p) {
          metrics.inc('fcgw_auth_failures_total', { reason: 'invalid' });
          return fail(res, 401, 'Unauthorized: Invalid token');
        }
        res.locals.principal = p;
        next();
      },
      (err) => {
        // The key store is down. 503, not 401: the caller's key may be perfectly valid.
        log.error('auth provider failed', { err, requestId: res.locals.requestId });
        metrics.inc('fcgw_auth_failures_total', { reason: 'provider_error' });
        fail(res, 503, 'Authentication is temporarily unavailable');
      },
    );
  };
}

export function rateLimit(limiter: RateLimiter, metrics: Metrics, log: Logger) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const { route, principal } = res.locals as Locals;
    limiter.take(principal.teamId, route.rate, principal.rateMultiplier).then((d) => {
      if (d.degraded) {
        metrics.inc('fcgw_ratelimit_degraded_total', { allowed: String(d.allowed) }, 1, 'Decisions made without Redis');
        log.warn('rate limiter degraded', { allowed: d.allowed });
      }
      res.set(rateLimitHeaders(route.rate, d));
      if (!d.allowed) {
        metrics.inc('fcgw_rate_limited_total', { class: route.rate }, 1, 'Requests answered 429');
        return fail(res, 429, `Rate limit exceeded for ${route.rate} requests. Retry after ${res.get('Retry-After') ?? '1'}s.`);
      }
      next();
    }, next);
  };
}

// ---------------------------------------------------------------------------------------------

export function createApp(d: GatewayDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', d.trustProxy);

  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    res.locals.requestId = incoming && /^[A-Za-z0-9._-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    res.locals.startedAt = performance.now();
    res.set('X-Request-Id', res.locals.requestId);
    res.on('finish', () => {
      const route = res.locals.route as Route | undefined;
      const label = route ? (route.kind === 'sync' ? route.endpoint : route.kind === 'credit-usage' ? 'credit-usage' : `${route.kind}:${route.job}`) : 'none';
      d.metrics.inc('fcgw_requests_total', { route: label, status: res.statusCode }, 1, 'Requests by route and status');
      d.metrics.observeMs('fcgw_request_duration_ms', { route: label }, performance.now() - res.locals.startedAt);
    });
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/ready', async (_req, res) => {
    try {
      await d.ready?.();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use(resolveRoute());
  app.use(express.raw({ type: () => true, limit: d.maxRequestBytes }));
  app.use(authenticate(d.auth, d.metrics, d.log));
  app.use(rateLimit(d.limiter, d.metrics, d.log));
  app.use((req, res, next) => handle(d, req, res).catch(next));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.too.large') return fail(res, 413, 'Request body too large');
    d.log.error('unhandled error', { err, requestId: res.locals.requestId });
    if (!res.headersSent) fail(res, 500, 'Internal gateway error');
  });
  return app;
}

async function handle(d: GatewayDeps, req: Request, res: Response): Promise<void> {
  const l = res.locals as Locals;
  const { route, principal } = l;
  const rawBody = Buffer.isBuffer(req.body) ? req.body : undefined;
  const body = parseJsonObject(rawBody);

  if (route.kind === 'credit-usage') {
    const b = await d.ledger.balance(principal.teamId);
    // Same shape as Firecrawl's GET /v2/team/credit-usage, so SDK getCreditUsage() works.
    res.json({
      success: true,
      data: {
        remainingCredits: b.remaining ?? Number.MAX_SAFE_INTEGER,
        planCredits: b.limit ?? Number.MAX_SAFE_INTEGER,
        billingPeriodStart: new Date(b.periodStart + 'T00:00:00Z').toISOString(),
        billingPeriodEnd: b.periodEnd,
      },
    });
    return;
  }

  if (route.kind === 'job-access') {
    // Self-hosted Firecrawl runs every request as one team, so it would show any caller any job.
    // 404 rather than 403: don't confirm that someone else's job id exists.
    if (!(await d.jobs.owns(principal.teamId, route.job, route.jobId))) {
      d.metrics.inc('fcgw_job_access_denied_total', { kind: route.job }, 1, 'Job reads by a team that does not own the job');
      fail(res, 404, 'Job not found');
      return;
    }
    const up = await forward(d, req, res, rawBody);
    if (up) send(d, req, res, up);
    return;
  }

  if (route.kind === 'job-create' && route.job === 'batch_scrape' && typeof body?.appendToId === 'string') {
    if (!(await d.jobs.owns(principal.teamId, 'batch_scrape', body.appendToId))) {
      fail(res, 404, 'Job not found');
      return;
    }
  }

  // Metered: sync requests and job creation.
  const perPage = route.kind === 'job-create' ? scrapeCredits(route.job === 'crawl' ? body?.scrapeOptions : body) : 0;
  const estimate =
    route.kind === 'job-create'
      ? perPage // a hold for one page proves the team can afford to start
      : route.endpoint === 'scrape'
        ? scrapeCredits(body)
        : route.endpoint === 'search'
          ? searchCredits(body ?? {})
          : 1;
  const reservationId = randomUUID();
  const reserved = await d.ledger.reserve(principal.teamId, estimate, reservationId, d.reservationTtlMs);
  if (!reserved.ok) {
    d.metrics.inc('fcgw_insufficient_credits_total', {}, 1, 'Requests answered 402');
    fail(res, 402, `Insufficient credits: this request needs about ${estimate}, ${reserved.remaining} remaining this month.`);
    return;
  }

  const endpoint = route.kind === 'sync' ? route.endpoint : route.job;
  const up = await forward(d, req, res, rawBody, () => settle(d, l, reservationId, endpoint, 0, null));
  if (!up) return;

  let credits = 0;
  if (route.kind === 'sync') {
    const reported = up.kind === 'buffered' ? reportedCredits(route.endpoint, up.json) : null;
    // Failed requests are free unless Firecrawl says otherwise; successes without a figure pay the estimate.
    credits = reported ?? (up.status < 400 ? estimate : 0);
  } else if (up.status < 400) {
    const id = up.kind === 'buffered' ? (up.json as Record<string, unknown> | undefined)?.id : undefined;
    let registered = false;
    if (typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id)) {
      try {
        await d.jobs.register({ id, kind: route.job, teamId: principal.teamId, keyId: principal.keyId, perPageCredits: perPage });
        registered = true;
      } catch (err) {
        d.log.error('could not record job', { err, requestId: l.requestId, jobId: id });
      }
    } else {
      d.log.error('job created without a usable id in the response', { requestId: l.requestId });
    }
    if (!registered) {
      // A job we can't record would run unbilled and be unreachable by its owner. Stop it.
      if (typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id)) {
        await d.upstream
          .send({ method: 'DELETE', pathAndQuery: JOB_PATH[route.job] + id, headers: {}, requestId: l.requestId })
          .catch((err) => d.log.error('could not cancel unrecorded job', { err, jobId: id }));
      }
      await settle(d, l, reservationId, endpoint, 0, up.status);
      if (up.kind === 'stream') up.stream.destroy();
      fail(res, 503, 'Could not record the job; it was cancelled. Retry the request.');
      return;
    }
  }
  await settle(d, l, reservationId, endpoint, credits, up.status);
  send(d, req, res, up);
}

async function settle(d: GatewayDeps, l: Locals, reservationId: string, endpoint: string, credits: number, status: number | null) {
  try {
    await d.ledger.settle(reservationId, {
      idempotencyKey: `req:${reservationId}`,
      teamId: l.principal.teamId,
      keyId: l.principal.keyId,
      endpoint,
      credits,
      upstreamStatus: status,
    });
    if (credits > 0) d.metrics.inc('fcgw_credits_charged_total', { endpoint }, credits, 'Credits charged');
  } catch (err) {
    // The response still goes out: the caller's work is done. The hold expires and the sweeper
    // releases it, so this request goes unbilled. Alert on this counter.
    d.metrics.inc('fcgw_settle_failures_total', { endpoint }, 1, 'Charges that could not be written');
    d.log.error('settle failed; request unbilled', { err, requestId: l.requestId, endpoint, credits });
  }
}

async function forward(d: GatewayDeps, req: Request, res: Response, body: Buffer | undefined, onFail?: () => Promise<void>): Promise<UpstreamResponse | null> {
  const l = res.locals as Locals;
  const t0 = performance.now();
  try {
    const up = await d.upstream.send({
      method: req.method,
      pathAndQuery: l.path,
      headers: req.headers,
      body,
      requestId: l.requestId,
      principal: { teamId: l.principal.teamId, keyId: l.principal.keyId },
    });
    d.metrics.observeMs('fcgw_upstream_duration_ms', { route: l.route.kind }, performance.now() - t0);
    return up;
  } catch (err) {
    await onFail?.();
    if (err instanceof UpstreamError) {
      d.metrics.inc('fcgw_upstream_errors_total', { reason: err.reason }, 1, 'Upstream timeouts and connection failures');
      fail(res, err.reason === 'timeout' ? 504 : 502, err.reason === 'timeout' ? 'Upstream timed out' : 'Upstream unavailable');
      return null;
    }
    throw err;
  }
}

function send(d: GatewayDeps, req: Request, res: Response, up: UpstreamResponse): void {
  up.headers.forEach((v, k) => {
    if (!k.toLowerCase().startsWith('ratelimit') && k.toLowerCase() !== 'x-request-id') res.setHeader(k, v);
  });
  res.status(up.status);
  if (up.kind === 'stream') {
    up.stream.on('error', () => res.destroy());
    up.stream.pipe(res);
    return;
  }
  if (up.json !== undefined && rewriteUrls(up.json, d.upstream.upstreamOrigin, publicOrigin(d, req))) {
    res.json(up.json);
    return;
  }
  res.end(up.body);
}

function publicOrigin(d: GatewayDeps, req: Request): string {
  if (d.publicBaseUrl) return new URL(d.publicBaseUrl).origin;
  return `${req.protocol}://${req.host}`;
}

function parseJsonObject(buf: Buffer | undefined): Record<string, any> | undefined {
  if (!buf || buf.length === 0) return undefined;
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
