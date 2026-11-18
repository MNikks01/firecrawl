import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Key format: `fcgw_<id>_<secret>`
 *   id     12 chars [a-z0-9], public, the database lookup key
 *   secret 32 random bytes, base64url (43 chars)
 *
 * A distinctive prefix lets secret scanners (GitHub push protection, gitleaks) spot leaked keys.
 * Secrets are high-entropy, so a fast hash (sha256) is the right choice: a slow KDF only helps
 * low-entropy passwords and would cost milliseconds on every request.
 */
const KEY_RE = /^fcgw_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface ParsedKey {
  id: string;
  secret: string;
}

export function parseKey(token: string): ParsedKey | null {
  const m = KEY_RE.exec(token);
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function secretMatches(secret: string, storedHash: Buffer): boolean {
  const h = hashSecret(secret);
  return h.length === storedHash.length && timingSafeEqual(h, storedHash);
}

export function generateKey(): { token: string; id: string; secretHash: Buffer } {
  const bytes = randomBytes(12);
  let id = '';
  // 36 does not divide 256, so reject-sample to keep ids uniform.
  for (let i = 0; id.length < 12; i++) {
    const b = i < bytes.length ? bytes[i]! : randomBytes(1)[0]!;
    if (b < 252) id += ID_ALPHABET[b % 36];
  }
  const secret = randomBytes(32).toString('base64url');
  return { token: `fcgw_${id}_${secret}`, id, secretHash: hashSecret(secret) };
}

/** Extract the bearer token. Firecrawl SDKs send `Authorization: Bearer <key>`. */
export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}
