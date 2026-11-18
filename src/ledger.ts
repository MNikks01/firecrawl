import type { Pool, PoolClient } from 'pg';

/** Calendar month in UTC, as the date of its first day. */
export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
export function periodEnd(periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString();
}

export type ReserveResult = { ok: true } | { ok: false; remaining: number };

export interface Balance {
  limit: number | null;
  used: number;
  reserved: number;
  remaining: number | null;
  periodStart: string;
  periodEnd: string;
}

export interface UsageEvent {
  idempotencyKey: string;
  teamId: string;
  keyId: string | null;
  endpoint: string;
  credits: number;
  upstreamStatus?: number | null;
  jobId?: string | null;
}

/**
 * Credits per team per month, in Postgres.
 *
 * Synchronous requests use reserve -> settle:
 *   reserve: one conditional UPDATE. Under READ COMMITTED, concurrent reservations on the
 *            same row queue on its lock and re-check `used + reserved + n <= limit` against
 *            the latest version, so a team can never be over-committed by racing requests.
 *   settle:  swaps the hold for the actual amount and writes the usage event, in one
 *            transaction. The event's idempotency key makes a repeated settle a no-op.
 * A gateway crash between the two leaves a reservation that the sweeper releases after its TTL.
 *
 * Async jobs (crawl, batch scrape) can't be reserved up front, so the reconciler charges as
 * pages complete (`charge`) and cancels the job once the team is over its limit.
 */
export class Ledger {
  constructor(
    private pool: Pool,
    private now: () => Date = () => new Date(),
  ) {}

  async reserve(teamId: string, credits: number, reservationId: string, ttlMs: number): Promise<ReserveResult> {
    const period = periodOf(this.now());
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.pool.query(
        `with upd as (
           update credit_periods cp set reserved = cp.reserved + $3
             from teams t
            where cp.team_id = $1 and cp.period_start = $2 and t.id = cp.team_id
              and (t.monthly_credits is null or cp.used + cp.reserved + $3 <= t.monthly_credits)
           returning cp.team_id
         )
         insert into reservations (id, team_id, period_start, credits, expires_at)
         select $4, team_id, $2, $3, now() + make_interval(secs => $5::double precision / 1000) from upd
         returning id`,
        [teamId, period, credits, reservationId, ttlMs],
      );
      if (res.rowCount === 1) return { ok: true };
      if (attempt === 1) break;
      // Either the limit check failed or this is the team's first request of the month. Make sure
      // the period row exists and try once more. Whether *this* insert created the row doesn't
      // matter: under concurrency another request may have just created it.
      await this.pool.query(`insert into credit_periods (team_id, period_start) values ($1, $2) on conflict do nothing`, [teamId, period]);
    }
    const b = await this.balance(teamId);
    return { ok: false, remaining: b.remaining ?? 0 };
  }

  /** Replace a reservation with the actual charge. Safe to call twice. */
  async settle(reservationId: string, event: UsageEvent): Promise<void> {
    // One statement (one round trip, atomic): drop the hold, write the event unless its key was
    // already used, and move both counters. Bills the month the request started in; if the hold
    // was already swept, the current month.
    await this.pool.query(
      `with r as (
         delete from reservations where id = $1 returning period_start, credits
       ), e as (
         insert into usage_events (idempotency_key, team_id, key_id, endpoint, credits, upstream_status, job_id)
         select $2, $3, $4, $5, $6, $7, $8 where $6::bigint > 0
         on conflict (idempotency_key) do nothing
         returning credits
       ), v as (
         select coalesce((select period_start from r), $9::date) as period_start,
                coalesce((select credits from r), 0) as held,
                coalesce((select credits from e), 0) as charged
       )
       insert into credit_periods (team_id, period_start, used, reserved)
       select $3, period_start, charged, 0 from v where held > 0 or charged > 0
       on conflict (team_id, period_start) do update
         set used = credit_periods.used + excluded.used,
             reserved = credit_periods.reserved - (select held from v)`,
      [
        reservationId,
        event.idempotencyKey,
        event.teamId,
        event.keyId,
        event.endpoint,
        event.credits,
        event.upstreamStatus ?? null,
        event.jobId ?? null,
        periodOf(this.now()),
      ],
    );
  }

  /**
   * Charge without a reservation (async job pages). Runs inside the caller's transaction so the
   * job's billed counters move together with the charge. Returns false if already applied.
   */
  async charge(c: PoolClient, event: UsageEvent, opts: { recordZero?: boolean } = {}): Promise<boolean> {
    // recordZero: write the event even at 0 credits, so its key still dedupes (job documents).
    if (event.credits <= 0 && !opts.recordZero) return true;
    const e = await c.query(
      `insert into usage_events (idempotency_key, team_id, key_id, endpoint, credits, upstream_status, job_id)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (idempotency_key) do nothing`,
      [event.idempotencyKey, event.teamId, event.keyId, event.endpoint, event.credits, event.upstreamStatus ?? null, event.jobId ?? null],
    );
    if (e.rowCount !== 1) return false;
    if (event.credits <= 0) return true;
    await c.query(
      `insert into credit_periods (team_id, period_start, used) values ($1, $2, $3)
       on conflict (team_id, period_start) do update set used = credit_periods.used + $3`,
      [event.teamId, periodOf(this.now()), event.credits],
    );
    return true;
  }

  async balance(teamId: string, q: Pick<Pool, 'query'> = this.pool): Promise<Balance> {
    const period = periodOf(this.now());
    const { rows } = await q.query<{ limit: string | null; used: string | null; reserved: string | null }>(
      `select t.monthly_credits as limit, cp.used, cp.reserved
         from teams t left join credit_periods cp on cp.team_id = t.id and cp.period_start = $2
        where t.id = $1`,
      [teamId, period],
    );
    const r = rows[0];
    const limit = r?.limit == null ? null : Number(r.limit);
    const used = Number(r?.used ?? 0);
    const reserved = Number(r?.reserved ?? 0);
    return {
      limit,
      used,
      reserved,
      remaining: limit == null ? null : Math.max(0, limit - used - reserved),
      periodStart: period,
      periodEnd: periodEnd(period),
    };
  }

  /** Release holds whose request never settled (crashed gateway). Returns credits released. */
  async sweepExpired(): Promise<number> {
    const { rows } = await this.pool.query<{ released: string | null }>(
      `with r as (
         delete from reservations where expires_at < now() returning team_id, period_start, credits
       ), s as (
         select team_id, period_start, sum(credits) as credits from r group by 1, 2
       ), u as (
         update credit_periods cp set reserved = cp.reserved - s.credits
           from s where cp.team_id = s.team_id and cp.period_start = s.period_start
         returning s.credits
       )
       select sum(credits)::text as released from u`,
    );
    return Number(rows[0]?.released ?? 0);
  }

  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (err) {
      await c.query('rollback').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
}
