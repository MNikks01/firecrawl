import type { RateClass } from './ratelimit.js';

export type JobKind = 'crawl' | 'batch_scrape';

export type Route =
  | { kind: 'sync'; endpoint: 'scrape' | 'map' | 'search'; rate: RateClass }
  | { kind: 'job-create'; job: JobKind; rate: RateClass }
  | { kind: 'job-access'; job: JobKind; jobId: string; rate: RateClass }
  | { kind: 'credit-usage'; rate: RateClass };

const JOB_ID = '([A-Za-z0-9-]{1,64})';

/**
 * Default deny: only these routes reach Firecrawl. Everything else, including /admin/*,
 * v0/v1, websockets and the team/agent/monitor surfaces, answers 404 from the gateway.
 * Adding a route means deciding how it is metered and who may see its jobs.
 */
const TABLE: Array<[method: string, re: RegExp, build: (m: RegExpExecArray) => Route]> = [
  ['POST', /^\/v2\/scrape$/, () => ({ kind: 'sync', endpoint: 'scrape', rate: 'scrape' })],
  ['POST', /^\/v2\/map$/, () => ({ kind: 'sync', endpoint: 'map', rate: 'scrape' })],
  ['POST', /^\/v2\/search$/, () => ({ kind: 'sync', endpoint: 'search', rate: 'scrape' })],
  ['POST', /^\/v2\/crawl$/, () => ({ kind: 'job-create', job: 'crawl', rate: 'crawl' })],
  ['POST', /^\/v2\/batch\/scrape$/, () => ({ kind: 'job-create', job: 'batch_scrape', rate: 'crawl' })],
  ['GET', new RegExp(`^/v2/crawl/${JOB_ID}(?:/errors)?$`), (m) => ({ kind: 'job-access', job: 'crawl', jobId: m[1]!, rate: 'status' })],
  ['DELETE', new RegExp(`^/v2/crawl/${JOB_ID}$`), (m) => ({ kind: 'job-access', job: 'crawl', jobId: m[1]!, rate: 'status' })],
  ['GET', new RegExp(`^/v2/batch/scrape/${JOB_ID}(?:/errors)?$`), (m) => ({ kind: 'job-access', job: 'batch_scrape', jobId: m[1]!, rate: 'status' })],
  ['DELETE', new RegExp(`^/v2/batch/scrape/${JOB_ID}$`), (m) => ({ kind: 'job-access', job: 'batch_scrape', jobId: m[1]!, rate: 'status' })],
  ['GET', /^\/v2\/team\/credit-usage$/, () => ({ kind: 'credit-usage', rate: 'status' })],
];

/** `path` must be the decoded pathname without the query string. */
export function matchRoute(method: string, path: string): Route | null {
  // Reserved words that would otherwise match the job-id pattern.
  if (/^\/v2\/crawl\/(ongoing|active|params-preview)$/.test(path)) return null;
  for (const [m, re, build] of TABLE) {
    if (m !== method) continue;
    const hit = re.exec(path);
    if (hit) return build(hit);
  }
  return null;
}
