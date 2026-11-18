import type { Pool } from 'pg';
import type { StaticKey } from '../config.js';
import { hashSecret, parseKey, secretMatches } from '../keys.js';
import type { AuthProvider, Principal } from './types.js';

/**
 * Keys from configuration (a secrets manager, a Kubernetes Secret, GitOps).
 * Teams are upserted at startup so metering and job ownership still work;
 * the key list itself is not stored. Rotating means redeploying with the new list.
 */
export class StaticAuthProvider implements AuthProvider {
  readonly name = 'static';
  private keys = new Map<string, { secretHash: Buffer; principal: Principal }>();

  private constructor() {}

  static async create(pool: Pool, entries: StaticKey[]): Promise<StaticAuthProvider> {
    const p = new StaticAuthProvider();
    for (const e of entries) {
      const parsed = parseKey(e.key);
      if (!parsed) throw new Error('STATIC_KEYS contains a malformed key');
      if (p.keys.has(parsed.id)) throw new Error(`STATIC_KEYS lists key id ${parsed.id} twice`);
      const { rows } = await pool.query<{ id: string; rate_multiplier: string }>(
        `insert into teams (name, monthly_credits, rate_multiplier) values ($1, $2, $3)
         on conflict (name) do update set monthly_credits = excluded.monthly_credits,
                                          rate_multiplier = excluded.rate_multiplier
         returning id, rate_multiplier`,
        [e.team, e.monthlyCredits, e.rateMultiplier],
      );
      const team = rows[0]!;
      p.keys.set(parsed.id, {
        secretHash: hashSecret(parsed.secret),
        principal: { teamId: team.id, teamName: e.team, keyId: parsed.id, rateMultiplier: Number(team.rate_multiplier) },
      });
    }
    return p;
  }

  async authenticate(token: string): Promise<Principal | null> {
    const parsed = parseKey(token);
    if (!parsed) return null;
    const k = this.keys.get(parsed.id);
    return k && secretMatches(parsed.secret, k.secretHash) ? k.principal : null;
  }
}
