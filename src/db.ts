import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export function createPool(url: string, max = 20): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on('error', () => {
    /* idle client errors surface on the next query */
  });
  return pool;
}

const here = dirname(fileURLToPath(import.meta.url));
/** migrations/ sits next to src/ in the repo and next to dist/src/ after a build. */
export async function migrationsDir(): Promise<string> {
  for (const candidate of [join(here, '..', 'migrations'), join(here, '..', '..', 'migrations')]) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error('migrations directory not found');
}

/** Apply *.sql in name order, each once, under an advisory lock so concurrent starts don't race. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query('select pg_advisory_lock(727274)');
    await c.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), 'utf8');
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into schema_migrations (name) values ($1)', [f]);
        await c.query('commit');
        applied.push(f);
      } catch (err) {
        await c.query('rollback');
        throw err;
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(727274)').catch(() => {});
    c.release();
  }
  return applied;
}
