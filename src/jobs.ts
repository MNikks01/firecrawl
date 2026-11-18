import type { Pool } from 'pg';
import type { Ledger } from './ledger.js';
import type { Logger } from './log.js';
import type { Metrics } from './metrics.js';
import type { JobKind } from './routes.js';

export const JOB_PATH: Record<JobKind, string> = { crawl: '/v2/crawl/', batch_scrape: '/v2/batch/scrape/' };
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
/** Firecrawl keeps job results for 24h; after that status is 404 and nothing more can be billed. */
const MAX_JOB_AGE_MS = 25 * 60 * 60 * 1000;

export class JobRegistry {
  constructor(private pool: Pool) {}

  async register(job: { id: string; kind: JobKind; teamId: string; keyId: string; perPageCredits: number }): Promise<void> {
    await this.pool.query(
      `insert into jobs (id, kind, team_id, key_id, per_page_credits) values ($1, $2, $3, $4, $5)
       on conflict (id) do nothing`,
      [job.id, job.kind, job.teamId, job.keyId, job.perPageCredits],
    );
  }

  /** True if this team created this job through the gateway. */
  async owns(teamId: string, kind: JobKind, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('select 1 from jobs where id = $1 and kind = $2 and team_id = $3', [id, kind, teamId]);
    return rowCount === 1;
  }
}

/** GET {kind}/{id}?skip=&limit= on the upstream. */
export type FetchPage = (kind: JobKind, id: string, skip: number, limit: number) => Promise<{ httpStatus: number; body: unknown }>;
export type CancelJob = (kind: JobKind, id: string) => Promise<void>;

interface Page {
  status: string;
  completed: number;
  docs: Array<{ scrapeId: string | null; credits: number | null }>;
  /** skip value of Firecrawl's `next` link, if any */
  nextSkip: number | null;
}

export interface ReconcilerOptions {
  intervalMs: number;
  batch?: number;
  pageSize?: number;
  maxPagesPerPass?: number;
}

/**
 * Bills crawls and batch scrapes document by document, and stops them when the team runs out.
 *
 * Self-hosted Firecrawl prices every page (doc.metadata.creditsUsed) but reports -1 for the job
 * total. So the reconciler reads each job's completed documents, in Firecrawl's own order
 * (finished_at, created_at, id), from a forward `?skip=` cursor, and charges each document once.
 *
 * - Exact: each charge is keyed `doc:<scrapeId>`, so a document re-read on a later page, a
 *   rescan, or a replay after a crash is never billed twice. Cursor and charges commit together.
 * - Complete: two workers can commit out of finished_at order, which can shift a document behind
 *   the cursor. When the job ends, distinct billed documents are compared with Firecrawl's
 *   `completed`; on a mismatch the job is rescanned once from 0, and any remaining gap is logged.
 * - Concurrency-safe: due jobs are claimed with FOR UPDATE SKIP LOCKED, so several replicas can
 *   run it. Runs whether or not the client ever polls.
 * - Quota: once the team is over its monthly limit, the job is cancelled upstream. The overrun is
 *   bounded by what Firecrawl crawls in one interval.
 *
 * Cost: every document crosses the private network a second time. That is the price of exact
 * per-page billing without patching Firecrawl (see README).
 */
export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private batch: number;
  private pageSize: number;
  private maxPages: number;

  constructor(
    private pool: Pool,
    private ledger: Ledger,
    private fetchPage: FetchPage,
    private cancel: CancelJob,
    private log: Logger,
    private metrics: Metrics,
    private opts: ReconcilerOptions,
  ) {
    this.batch = opts.batch ?? 20;
    this.pageSize = opts.pageSize ?? 100;
    this.maxPages = opts.maxPagesPerPass ?? 20;
  }

  start(): void {
    const tick = () => {
      this.runOnce()
        .catch((err) => this.log.error('reconcile tick failed', { err }))
        .finally(() => {
          if (this.timer) this.timer = setTimeout(tick, this.opts.intervalMs);
        });
    };
    this.timer = setTimeout(tick, this.opts.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  /** One pass: release stale reservations, then work every due job. Returns jobs worked. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const released = await this.ledger.sweepExpired();
      if (released > 0) {
        this.metrics.inc('fcgw_reservations_released_credits_total', {}, released, 'Credits released from reservations that never settled');
        this.log.warn('released stale reservations', { credits: released });
      }
      // Claim with a lease (6 intervals); a successful pass sets the normal next check.
      const { rows } = await this.pool.query<{ id: string; kind: JobKind }>(
        `update jobs set next_check_at = now() + make_interval(secs => $1::double precision / 1000)
          where id in (select id from jobs where status = 'open' and next_check_at <= now()
                        order by next_check_at limit $2 for update skip locked)
          returning id, kind`,
        [this.opts.intervalMs * 6, this.batch],
      );
      for (const j of rows) {
        try {
          await this.work(j.id, j.kind);
        } catch (err) {
          this.log.error('reconcile job failed', { jobId: j.id, err });
        }
      }
      return rows.length;
    } finally {
      this.running = false;
    }
  }

  private async work(id: string, kind: JobKind): Promise<void> {
    for (let i = 0; i < this.maxPages; i++) {
      const cur = await this.pool.query<{ doc_cursor: number }>(`select doc_cursor from jobs where id = $1 and status = 'open'`, [id]);
      if (!cur.rows[0]) return;
      const cursor = cur.rows[0].doc_cursor;

      let page: Page | 'gone';
      try {
        const r = await this.fetchPage(kind, id, cursor, this.pageSize);
        if (r.httpStatus === 404) page = 'gone';
        else if (r.httpStatus >= 400) throw new Error(`status ${r.httpStatus}`);
        else page = parsePage(r.body);
      } catch (err) {
        this.metrics.inc('fcgw_reconcile_errors_total', { kind }, 1, 'Failed job status reads');
        await this.pool.query(
          `update jobs set failures = failures + 1,
                  next_check_at = now() + make_interval(secs => least(300, 5 * power(2, least(failures, 6)))::double precision)
            where id = $1`,
          [id],
        );
        this.log.warn('job page read failed', { jobId: id, kind, err });
        return;
      }

      const step = await this.apply(id, kind, cursor, page);
      if (step.cancel) {
        await this.cancelForCredits(id, kind);
        return;
      }
      if (step.done) break;
    }
    await this.pool.query(
      `update jobs set next_check_at = now() + make_interval(secs => $2::double precision / 1000) where id = $1 and status = 'open'`,
      [id, this.opts.intervalMs],
    );
  }

  /** Charge one page of documents and move the cursor, atomically. */
  private apply(id: string, kind: JobKind, cursor: number, page: Page | 'gone'): Promise<{ done: boolean; cancel: boolean }> {
    return this.ledger.tx(async (c) => {
      const { rows } = await c.query<{
        team_id: string;
        key_id: string | null;
        per_page_credits: number;
        doc_cursor: number;
        billed_docs: number;
        billed_credits: string;
        rescanned: boolean;
        status: string;
        created_at: Date;
      }>(
        `select team_id, key_id, per_page_credits, doc_cursor, billed_docs, billed_credits, rescanned, status, created_at
           from jobs where id = $1 for update`,
        [id],
      );
      const job = rows[0];
      // Another replica moved this job meanwhile: drop this page, it will be re-read.
      if (!job || job.status !== 'open' || job.doc_cursor !== cursor) return { done: true, cancel: false };

      if (page === 'gone') {
        await this.close(c, id, 'upstream_gone');
        this.log.warn('job expired upstream before billing finished', { jobId: id, billedDocs: job.billed_docs });
        this.metrics.inc('fcgw_metering_gaps_total', { reason: 'upstream_gone' }, 1, 'Jobs closed with documents possibly unbilled');
        return { done: true, cancel: false };
      }

      let newDocs = 0;
      let newCredits = 0;
      for (const [i, d] of page.docs.entries()) {
        const credits = d.credits ?? job.per_page_credits;
        const inserted = await this.ledger.charge(
          c,
          {
            idempotencyKey: d.scrapeId ? `doc:${d.scrapeId}` : `job:${id}:pos:${cursor + i}`,
            teamId: job.team_id,
            keyId: job.key_id,
            endpoint: kind,
            credits,
            jobId: id,
          },
          { recordZero: true },
        );
        if (inserted) {
          newDocs++;
          newCredits += credits;
        }
      }
      if (newCredits > 0) this.metrics.inc('fcgw_credits_charged_total', { endpoint: kind }, newCredits, 'Credits charged');

      const billedDocs = job.billed_docs + newDocs;
      let nextCursor = page.nextSkip ?? cursor + page.docs.length;
      const readAll = page.nextSkip === null || (page.docs.length === 0 && nextCursor >= page.completed);
      const ended = TERMINAL.has(page.status) || Date.now() - job.created_at.getTime() > MAX_JOB_AGE_MS;
      let close: string | null = null;
      let rescanned = job.rescanned;

      if (ended && readAll) {
        if (billedDocs >= page.completed || job.rescanned) {
          close = `upstream_${page.status}`;
          if (billedDocs < page.completed) {
            this.metrics.inc('fcgw_metering_gaps_total', { reason: 'missing_documents' });
            this.log.warn('job closed with fewer billed documents than completed', { jobId: id, billedDocs, completed: page.completed });
          }
        } else {
          // Something slipped behind the cursor. One full pass from the start; scrapeId dedupes.
          nextCursor = 0;
          rescanned = true;
        }
      }

      await c.query(
        `update jobs set doc_cursor = $2, billed_docs = $3, billed_credits = billed_credits + $4, rescanned = $5, failures = 0 where id = $1`,
        [id, nextCursor, billedDocs, newCredits, rescanned],
      );
      if (close) {
        await this.close(c, id, close);
        return { done: true, cancel: false };
      }

      const b = await this.ledger.balance(job.team_id, c);
      const over = b.limit !== null && b.used >= b.limit && !ended;
      const caughtUp = page.docs.length === 0 || page.nextSkip === null;
      const startedRescan = rescanned && !job.rescanned;
      return { done: caughtUp && !startedRescan, cancel: over };
    });
  }

  private async close(c: { query: Pool['query'] }, id: string, reason: string) {
    await c.query(`update jobs set status = 'closed', close_reason = coalesce(close_reason, $2), closed_at = now() where id = $1`, [id, reason]);
  }

  private async cancelForCredits(id: string, kind: JobKind): Promise<void> {
    try {
      await this.cancel(kind, id);
      // Stays open: what was crawled before the cancel landed still gets billed on later passes,
      // and the job closes as `upstream_cancelled` once read to the end.
      await this.pool.query(`update jobs set close_reason = 'credits_exhausted' where id = $1`, [id]);
      this.metrics.inc('fcgw_jobs_cancelled_total', { kind, reason: 'credits_exhausted' }, 1, 'Jobs cancelled by the gateway');
      this.log.info('cancelled job: team out of credits', { jobId: id, kind });
    } catch (err) {
      this.log.error('cancel failed; will retry next pass', { jobId: id, kind, err });
    }
  }
}

function parsePage(body: unknown): Page {
  const b = (body ?? {}) as Record<string, unknown>;
  const data = Array.isArray(b.data) ? b.data : [];
  let nextSkip: number | null = null;
  if (typeof b.next === 'string') {
    try {
      const s = Number(new URL(b.next).searchParams.get('skip'));
      if (Number.isInteger(s) && s >= 0) nextSkip = s;
    } catch {
      /* ignore */
    }
  }
  return {
    status: typeof b.status === 'string' ? b.status : 'unknown',
    completed: typeof b.completed === 'number' && b.completed >= 0 ? Math.floor(b.completed) : 0,
    nextSkip,
    docs: data.map((d) => {
      const m = ((d ?? {}) as Record<string, any>).metadata ?? {};
      const cu = m.creditsUsed;
      return {
        scrapeId: typeof m.scrapeId === 'string' && m.scrapeId.length > 0 ? m.scrapeId : null,
        credits: typeof cu === 'number' && Number.isFinite(cu) && cu >= 0 ? Math.ceil(cu) : null,
      };
    }),
  };
}
