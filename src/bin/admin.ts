import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Redis } from 'ioredis';
import { createPool, migrate } from '../db.js';
import { generateKey } from '../keys.js';
import { Ledger } from '../ledger.js';
import { INVALIDATE_CHANNEL } from '../wiring.js';

const USAGE = `usage: admin <command> [options]

  migrate
  team:create <name> [--monthly-credits <n|unlimited>] [--rate-multiplier <x>]
  team:update <name> [--monthly-credits <n|unlimited>] [--rate-multiplier <x>]
  team:list
  key:create <team> [--name <label>]        prints the key once; only its hash is stored
  key:list <team>
  key:revoke <key-id>                       takes effect on every gateway replica immediately
  key:generate                              a key for STATIC_KEYS (no database)
  usage <team>                              this month's balance and usage by endpoint
  load-seed --out <file>                    teams and keys for the k6 load test

env: DATABASE_URL, REDIS_URL (key:revoke)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'monthly-credits': { type: 'string' },
    'rate-multiplier': { type: 'string' },
    name: { type: 'string' },
    out: { type: 'string' },
  },
});
const [cmd, arg] = positionals;

function credits(v: string | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === 'unlimited') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error('--monthly-credits must be a non-negative integer or "unlimited"');
  return n;
}
function multiplier(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!(n > 0)) throw new Error('--rate-multiplier must be > 0');
  return n;
}
function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}\n\n${USAGE}`);
  return v;
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(USAGE);
  if (cmd === 'key:generate') {
    const k = generateKey();
    return console.log(k.token);
  }

  const pool = createPool(need(process.env.DATABASE_URL, 'DATABASE_URL'), 2);
  try {
    switch (cmd) {
      case 'migrate': {
        const applied = await migrate(pool);
        console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
        break;
      }
      case 'team:create': {
        const mc = credits(values['monthly-credits']);
        const { rows } = await pool.query(
          'insert into teams (name, monthly_credits, rate_multiplier) values ($1, $2, $3) returning id',
          [need(arg, 'team name'), mc === undefined ? 0 : mc, multiplier(values['rate-multiplier']) ?? 1],
        );
        console.log(`team ${arg} ${rows[0].id}`);
        break;
      }
      case 'team:update': {
        const mc = credits(values['monthly-credits']);
        const rm = multiplier(values['rate-multiplier']);
        const r = await pool.query(
          `update teams set monthly_credits = case when $2 then $3::bigint else monthly_credits end,
                            rate_multiplier = coalesce($4, rate_multiplier)
            where name = $1`,
          [need(arg, 'team name'), mc !== undefined, mc ?? null, rm ?? null],
        );
        if (r.rowCount !== 1) throw new Error(`no team ${arg}`);
        console.log('updated (rate changes apply when cached keys expire, within AUTH_CACHE_TTL_MS)');
        break;
      }
      case 'team:list': {
        const { rows } = await pool.query('select name, monthly_credits, rate_multiplier, created_at from teams order by name');
        console.table(rows);
        break;
      }
      case 'key:create': {
        const team = await pool.query<{ id: string }>('select id from teams where name = $1', [need(arg, 'team name')]);
        if (!team.rows[0]) throw new Error(`no team ${arg}`);
        const k = generateKey();
        await pool.query('insert into api_keys (id, team_id, name, secret_hash) values ($1, $2, $3, $4)', [
          k.id,
          team.rows[0].id,
          values.name ?? 'default',
          k.secretHash,
        ]);
        console.error(`key ${k.id} created for ${arg}. Store it now; it can't be shown again.`);
        console.log(k.token);
        break;
      }
      case 'key:list': {
        const { rows } = await pool.query(
          `select k.id, k.name, k.created_at, k.last_used_at, k.revoked_at from api_keys k join teams t on t.id = k.team_id
            where t.name = $1 order by k.created_at`,
          [need(arg, 'team name')],
        );
        console.table(rows);
        break;
      }
      case 'key:revoke': {
        const id = need(arg, 'key id');
        const r = await pool.query('update api_keys set revoked_at = now() where id = $1 and revoked_at is null', [id]);
        if (r.rowCount !== 1) throw new Error(`no active key ${id}`);
        const url = process.env.REDIS_URL;
        if (url) {
          const redis = new Redis(url, { maxRetriesPerRequest: 1 });
          try {
            await redis.publish(INVALIDATE_CHANNEL, id);
            console.log(`revoked ${id}; gateways notified`);
          } finally {
            redis.disconnect();
          }
        } else {
          console.log(`revoked ${id}. REDIS_URL not set: gateways drop it when their cache expires (AUTH_CACHE_TTL_MS)`);
        }
        break;
      }
      case 'usage': {
        const team = await pool.query<{ id: string }>('select id from teams where name = $1', [need(arg, 'team name')]);
        if (!team.rows[0]) throw new Error(`no team ${arg}`);
        const b = await new Ledger(pool).balance(team.rows[0].id);
        console.log(b);
        const { rows } = await pool.query(
          `select endpoint, count(*)::int as events, sum(credits)::int as credits from usage_events
            where team_id = $1 and created_at >= $2::date group by endpoint order by credits desc`,
          [team.rows[0].id, b.periodStart],
        );
        console.table(rows);
        break;
      }
      case 'load-seed': {
        const out = need(values.out, '--out');
        const suffix = Date.now().toString(36);
        const make = async (name: string, mc: number | null, rm: number) => {
          const t = await pool.query<{ id: string }>('insert into teams (name, monthly_credits, rate_multiplier) values ($1, $2, $3) returning id', [
            `${name}-${suffix}`,
            mc,
            rm,
          ]);
          const k = generateKey();
          await pool.query('insert into api_keys (id, team_id, name, secret_hash) values ($1, $2, $3, $4)', [k.id, t.rows[0]!.id, 'k6', k.secretHash]);
          return k.token;
        };
        const seed = {
          // Unlimited credits, rate limit far above the test rate: measures pure gateway overhead.
          throughput: await make('k6-throughput', null, 1000),
          // Default rate limits (multiplier 1), unlimited credits: measures 429 behaviour.
          ratelimited: await make('k6-ratelimited', null, 1),
          // 300 credits, huge rate limit: concurrent requests must never overspend.
          quota: await make('k6-quota', 300, 1000),
        };
        await writeFile(out, JSON.stringify(seed));
        console.log(`seeded ${Object.keys(seed).length} teams -> ${out}`);
        break;
      }
      default:
        throw new Error(`unknown command ${cmd}\n\n${USAGE}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
