/**
 * A stand-in for a self-hosted Firecrawl API (v2 shapes as of commit 25c1302), for tests and the
 * load test. It reproduces what matters to the gateway:
 *   - scrape reports data.metadata.creditsUsed; search reports creditsUsed; map reports nothing
 *   - crawl/batch status reports creditsUsed: -1 (self-hosted has no Bigtable/ClickHouse)
 *   - `url` and `next` are built from the Host header, like Firecrawl's req.host
 *   - every job belongs to the one implicit team, so any caller can read any job id
 *   - /admin/* exists
 * Pages of a crawl complete at MOCK_PAGES_PER_SEC from creation.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import express from 'express';

interface Job {
  kind: 'crawl' | 'batch';
  total: number;
  createdAt: number;
  cancelledAt: number | null;
  /** completed pages are frozen here once cancelled */
  frozen: number | null;
}

export interface MockState {
  jobs: Map<string, Job>;
  authHeadersSeen: number;
  requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }>;
  pagesPerSec: number;
  latencyMs: number;
}

/** Every 5th document is a 3-page PDF: 1 + 2 extra pages. An estimate can't know this; the document can. */
export function docCredits(n: number): number {
  return n % 5 === 4 ? 3 : 1;
}

function scrapeCost(body: any): number {
  const formats: any[] = Array.isArray(body?.formats) ? body.formats : [];
  const hasJson = formats.some((f) => f === 'json' || f?.type === 'json');
  return 1 + (hasJson ? 4 : 0);
}

export function createMock(opts: { pagesPerSec?: number; latencyMs?: number; keepRequests?: boolean } = {}) {
  const state: MockState = {
    jobs: new Map(),
    authHeadersSeen: 0,
    requests: [],
    pagesPerSec: opts.pagesPerSec ?? 5,
    latencyMs: opts.latencyMs ?? 0,
  };
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => {
    if (req.headers.authorization) state.authHeadersSeen++;
    if (opts.keepRequests) state.requests.push({ method: req.method, path: req.originalUrl, headers: req.headers });
    if (state.latencyMs > 0) setTimeout(next, state.latencyMs);
    else next();
  });
  const origin = (req: express.Request) => `${req.protocol}://${req.host}`;

  const completed = (j: Job) => j.frozen ?? Math.min(j.total, Math.floor(((Date.now() - j.createdAt) / 1000) * state.pagesPerSec));

  app.post('/v2/scrape', (req, res) => {
    const url = String(req.body?.url ?? '');
    if (url.includes('fail')) return res.status(500).json({ success: false, error: 'Scrape failed', code: 'SCRAPE_ALL_ENGINES_FAILED' });
    res.json({
      success: true,
      data: { markdown: '# Example\n\nmocked', metadata: { url, sourceURL: url, statusCode: 200, creditsUsed: scrapeCost(req.body) } },
    });
  });

  app.post('/v2/map', (req, res) => {
    res.json({ success: true, links: [{ url: String(req.body?.url ?? '') }] });
  });

  app.post('/v2/search', (req, res) => {
    const limit = Number(req.body?.limit ?? 5);
    res.json({ success: true, data: { web: Array.from({ length: limit }, (_, i) => ({ url: `https://example.com/${i}` })) }, creditsUsed: Math.ceil(limit / 10) * 2, id: randomUUID() });
  });

  const create = (kind: Job['kind']) => (req: express.Request, res: express.Response) => {
    if (kind === 'crawl' && typeof req.body?.url !== 'string') return res.status(400).json({ success: false, error: 'url required' });
    const total = kind === 'crawl' ? Math.min(Number(req.body?.limit ?? 10), 10_000) : (req.body?.urls ?? []).length;
    const appendTo = kind === 'batch' && typeof req.body?.appendToId === 'string' ? req.body.appendToId : null;
    if (appendTo && state.jobs.has(appendTo)) {
      state.jobs.get(appendTo)!.total += total;
      return res.json({ success: true, id: appendTo, url: `${origin(req)}/v2/batch/scrape/${appendTo}` });
    }
    const id = randomUUID();
    state.jobs.set(id, { kind, total, createdAt: Date.now(), cancelledAt: null, frozen: null });
    res.json({ success: true, id, url: `${origin(req)}/v2/${kind === 'crawl' ? 'crawl' : 'batch/scrape'}/${id}` });
  };
  app.post('/v2/crawl', create('crawl'));
  app.post('/v2/batch/scrape', create('batch'));

  const status = (kind: Job['kind']) => (req: express.Request, res: express.Response) => {
    const j = state.jobs.get(String(req.params.id));
    if (!j || j.kind !== kind) return res.status(404).json({ success: false, error: 'Job not found' });
    const done = completed(j);
    const skip = Number(req.query.skip ?? 0);
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const end = Math.min(done, skip + limit);
    const data = Array.from({ length: Math.max(0, end - skip) }, (_, k) => {
      const n = skip + k;
      return { markdown: `page ${n}`, metadata: { scrapeId: `${req.params.id}-${n}`, statusCode: 200, creditsUsed: docCredits(n) } };
    });
    const base = `${origin(req)}/v2/${kind === 'crawl' ? 'crawl' : 'batch/scrape'}/${req.params.id}`;
    const st = j.cancelledAt ? 'cancelled' : done >= j.total ? 'completed' : 'scraping';
    res.json({
      success: true,
      status: st,
      completed: done,
      total: j.total,
      creditsUsed: -1,
      expiresAt: new Date(j.createdAt + 86_400_000).toISOString(),
      // Like Firecrawl: always a next link while scraping, and while documents remain.
      next: st === 'scraping' || done > end ? `${base}?skip=${end}${req.query.limit ? `&limit=${req.query.limit}` : ''}` : undefined,
      data,
    });
  };
  app.get('/v2/crawl/:id', status('crawl'));
  app.get('/v2/batch/scrape/:id', status('batch'));
  app.get('/v2/crawl/:id/errors', (_req, res) => res.json({ errors: [], robotsBlocked: [] }));

  const cancel = (kind: Job['kind']) => (req: express.Request, res: express.Response) => {
    const j = state.jobs.get(String(req.params.id));
    if (!j || j.kind !== kind) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!j.cancelledAt) {
      j.frozen = completed(j);
      j.cancelledAt = Date.now();
    }
    res.json({ success: true, status: 'cancelled' });
  };
  app.delete('/v2/crawl/:id', cancel('crawl'));
  app.delete('/v2/batch/scrape/:id', cancel('batch'));

  app.get('/v2/crawl/ongoing', (_req, res) => res.json({ success: true, crawls: [...state.jobs.keys()].map((id) => ({ id })) }));
  app.use('/admin', (_req, res) => res.json({ queues: 'exposed' }));
  app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

  return { app, state };
}

// Run standalone: `node dist/mock/firecrawl-mock.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3002);
  const { app } = createMock({ pagesPerSec: Number(process.env.MOCK_PAGES_PER_SEC ?? 5), latencyMs: Number(process.env.MOCK_LATENCY_MS ?? 50) });
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.listen(port, () => console.log(JSON.stringify({ msg: 'firecrawl mock listening', port })));
}
