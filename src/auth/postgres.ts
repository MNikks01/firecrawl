import type { Pool } from 'pg';
import { parseKey, secretMatches } from '../keys.js';
import type { AuthProvider, Principal } from './types.js';

interface CacheEntry {
  /** null = negative entry (unknown or revoked id). */
  row: { secretHash: Buffer; principal: Principal } | null;
  expiresAt: number;
}

const NEGATIVE_TTL_MS = 5_000;
const LAST_USED_DEBOUNCE_MS = 60_000;
const MAX_CACHE = 50_000;

/**
 * API keys in Postgres. Hot path: one in-process cache hit and a sha256.
 *
 * - The cache holds the stored hash, never the token, and re-checks the secret on every hit.
 * - Unknown ids get a short negative entry, so random tokens can't hammer the database.
 * - Revocation is immediate on every replica through `invalidate` (wired to Redis pub/sub);
 *   without the bus, a revoked key keeps working for at most AUTH_CACHE_TTL_MS.
 * - last_used_at is written at most once a minute per key, off the request path.
 */
export class PostgresAuthProvider implements AuthProvider {
  readonly name = 'postgres';
  private cache = new Map<string, CacheEntry>();
  private lastUsedWrite = new Map<string, number>();

  constructor(
    private pool: Pool,
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  async authenticate(token: string): Promise<Principal | null> {
    const parsed = parseKey(token);
    if (!parsed) return null; // malformed: no database round trip

    let entry = this.cache.get(parsed.id);
    if (!entry || entry.expiresAt <= this.now()) {
      entry = await this.load(parsed.id);
      if (this.cache.size >= MAX_CACHE) this.cache.clear();
      this.cache.set(parsed.id, entry);
    }
    if (!entry.row || !secretMatches(parsed.secret, entry.row.secretHash)) return null;
    this.touch(parsed.id);
    return entry.row.principal;
  }

  invalidate(keyId: string): void {
    this.cache.delete(keyId);
  }

  private async load(id: string): Promise<CacheEntry> {
    const { rows } = await this.pool.query<{
      secret_hash: Buffer;
      team_id: string;
      team_name: string;
      rate_multiplier: string;
    }>(
      `select k.secret_hash, k.team_id, t.name as team_name, t.rate_multiplier
         from api_keys k join teams t on t.id = k.team_id
        where k.id = $1 and k.revoked_at is null`,
      [id],
    );
    const r = rows[0];
    if (!r) return { row: null, expiresAt: this.now() + Math.min(NEGATIVE_TTL_MS, this.ttlMs) };
    return {
      row: {
        secretHash: r.secret_hash,
        principal: { teamId: r.team_id, teamName: r.team_name, keyId: id, rateMultiplier: Number(r.rate_multiplier) },
      },
      expiresAt: this.now() + this.ttlMs,
    };
  }

  private touch(id: string): void {
    const t = this.now();
    if ((this.lastUsedWrite.get(id) ?? 0) + LAST_USED_DEBOUNCE_MS > t) return;
    this.lastUsedWrite.set(id, t);
    this.pool.query('update api_keys set last_used_at = now() where id = $1', [id]).catch(() => {
      /* best effort */
    });
  }
}
