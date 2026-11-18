/**
 * Credit estimates, used for two things:
 *   1. the reservation held before a synchronous request (scrape, map, search);
 *   2. the per-page price of crawls and batch scrapes, which Firecrawl self-hosted
 *      does not report (crawl status `creditsUsed` is -1 without Bigtable or ClickHouse).
 *
 * Synchronous requests settle at what Firecrawl reports in the response, so the estimate
 * only sizes the hold. The table mirrors apps/api/src/lib/scrape-billing.ts at commit 25c1302,
 * limited to surcharges that apply to a self-hosted instance.
 */

type Format = string | { type?: string; modes?: string[] };

const SURCHARGE_FORMATS: Record<string, number> = {
  json: 4,
  question: 4,
  query: 4,
  highlights: 4,
  audio: 4,
  video: 4,
};

function formatTypes(formats: unknown): string[] {
  if (!Array.isArray(formats)) return [];
  return (formats as Format[]).flatMap((f) => {
    if (typeof f === 'string') return [f];
    if (f && typeof f === 'object' && typeof f.type === 'string') {
      // changeTracking with a json mode is billed like json.
      if (f.type === 'changeTracking' && Array.isArray(f.modes) && f.modes.includes('json')) return ['changeTracking', 'json'];
      return [f.type];
    }
    return [];
  });
}

/** Credits for one scraped page with these scrapeOptions. */
export function scrapeCredits(opts: unknown): number {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>;
  const types = new Set(formatTypes(o.formats));
  // deterministicJson replaces the base price: 10 when Firecrawl generates the extractor, 3 when cached.
  // We can't know which ahead of time, so we take the upper bound.
  let credits = types.has('deterministicJson') ? 10 : 1;
  for (const t of types) credits += SURCHARGE_FORMATS[t] ?? 0;
  if (o.lockdown === true) credits += 4;
  if (o.redactPII === true) credits += 4;
  if (o.zeroDataRetention === true && o.lockdown !== true) credits += 1;
  return credits;
}

/** Hold for POST /v2/search: 2 credits per 10 results, plus a scrape per result when scraping. */
export function searchCredits(body: Record<string, unknown>): number {
  const limit = typeof body.limit === 'number' && body.limit > 0 ? Math.min(Math.floor(body.limit), 100) : 10;
  const base = Math.ceil(limit / 10) * 2;
  const so = body.scrapeOptions as Record<string, unknown> | undefined;
  const scrapes = so && Array.isArray(so.formats) && so.formats.length > 0 ? limit * scrapeCredits(so) : 0;
  return base + scrapes;
}

/** Pull the credits Firecrawl reports, if it reports them. */
export function reportedCredits(endpoint: 'scrape' | 'search' | 'map', body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  const v = endpoint === 'scrape' ? b.data?.metadata?.creditsUsed : endpoint === 'search' ? b.creditsUsed : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.ceil(v) : null;
}
