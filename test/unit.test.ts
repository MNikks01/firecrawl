import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { bearer, generateKey, hashSecret, parseKey, secretMatches } from '../src/keys.js';
import { periodEnd, periodOf } from '../src/ledger.js';
import { reportedCredits, scrapeCredits, searchCredits } from '../src/pricing.js';
import { rewriteUrls } from '../src/proxy.js';
import { matchRoute } from '../src/routes.js';

describe('keys', () => {
  it('round-trips a generated key and stores only a hash', () => {
    const k = generateKey();
    const p = parseKey(k.token)!;
    expect(p.id).toBe(k.id);
    expect(k.token).toMatch(/^fcgw_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(secretMatches(p.secret, k.secretHash)).toBe(true);
    expect(k.secretHash.equals(hashSecret(p.secret))).toBe(true);
    expect(k.secretHash.toString('hex')).not.toContain(p.secret);
  });

  it('rejects a wrong secret and malformed tokens', () => {
    const a = generateKey();
    const b = generateKey();
    expect(secretMatches(parseKey(b.token)!.secret, a.secretHash)).toBe(false);
    for (const t of ['', 'fc-123', 'fcgw_short_x', a.token + 'x', a.token.toUpperCase(), `fcgw_${'a'.repeat(12)}_${'b'.repeat(42)}`]) {
      expect(parseKey(t)).toBeNull();
    }
  });

  it('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateKey().id));
    expect(ids.size).toBe(2000);
  });

  it('parses Bearer headers', () => {
    expect(bearer('Bearer abc')).toBe('abc');
    expect(bearer('bearer abc ')).toBe('abc');
    expect(bearer('Basic abc')).toBeNull();
    expect(bearer('Bearer a b')).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });
});

describe('pricing (mirrors scrape-billing.ts @ 25c1302)', () => {
  it('prices a page from its scrape options', () => {
    expect(scrapeCredits({})).toBe(1);
    expect(scrapeCredits({ formats: ['markdown'] })).toBe(1);
    expect(scrapeCredits({ formats: ['markdown', { type: 'json', prompt: 'x' }] })).toBe(5);
    expect(scrapeCredits({ formats: [{ type: 'changeTracking', modes: ['json'] }] })).toBe(5);
    expect(scrapeCredits({ formats: ['json'], lockdown: true })).toBe(9);
    expect(scrapeCredits({ formats: [{ type: 'deterministicJson' }] })).toBe(10);
    expect(scrapeCredits({ zeroDataRetention: true })).toBe(2);
    expect(scrapeCredits({ zeroDataRetention: true, lockdown: true })).toBe(5);
    expect(scrapeCredits(null)).toBe(1);
  });

  it('holds 2 per 10 search results plus scrapes', () => {
    expect(searchCredits({})).toBe(2);
    expect(searchCredits({ limit: 25 })).toBe(6);
    expect(searchCredits({ limit: 5, scrapeOptions: { formats: ['markdown'] } })).toBe(2 + 5);
    expect(searchCredits({ limit: 10_000 })).toBe(20); // capped at 100 results
  });

  it('reads what Firecrawl reports, and nothing else', () => {
    expect(reportedCredits('scrape', { data: { metadata: { creditsUsed: 5 } } })).toBe(5);
    expect(reportedCredits('scrape', { data: { metadata: {} } })).toBeNull();
    expect(reportedCredits('search', { creditsUsed: 4 })).toBe(4);
    expect(reportedCredits('search', { creditsUsed: -1 })).toBeNull();
    expect(reportedCredits('map', { creditsUsed: 9 })).toBeNull();
  });
});

describe('route table (default deny)', () => {
  it('allows the metered v2 surface', () => {
    expect(matchRoute('POST', '/v2/scrape')).toMatchObject({ kind: 'sync', endpoint: 'scrape' });
    expect(matchRoute('POST', '/v2/crawl')).toMatchObject({ kind: 'job-create', job: 'crawl' });
    expect(matchRoute('GET', '/v2/crawl/7f1c-ab')).toMatchObject({ kind: 'job-access', jobId: '7f1c-ab' });
    expect(matchRoute('GET', '/v2/crawl/7f1c/errors')).toMatchObject({ kind: 'job-access', jobId: '7f1c' });
    expect(matchRoute('DELETE', '/v2/batch/scrape/abc')).toMatchObject({ kind: 'job-access', job: 'batch_scrape' });
    expect(matchRoute('GET', '/v2/team/credit-usage')).toMatchObject({ kind: 'credit-usage' });
  });

  it('denies everything else', () => {
    for (const [m, p] of [
      ['GET', '/admin/queues'],
      ['POST', '/v1/scrape'],
      ['GET', '/v2/crawl/active'],
      ['GET', '/v2/crawl/ongoing'],
      ['POST', '/v2/crawl/params-preview'],
      ['GET', '/v2/team/queue-status'],
      ['POST', '/v2/extract'],
      ['POST', '/v2/agent'],
      ['GET', '/v2/scrape'],
      ['POST', '/v2/scrape/'],
      ['POST', '/V2/SCRAPE'],
      ['GET', '/v2/crawl/a%2F..%2Fb'],
      ['GET', '/v2/crawl/' + 'a'.repeat(65)],
    ] as const) {
      expect(matchRoute(m, p), `${m} ${p}`).toBeNull();
    }
  });
});

describe('url rewriting', () => {
  it('points Firecrawl-built links at the gateway, and only those', () => {
    const body = { id: 'x', url: 'http://api:3002/v2/crawl/x', next: 'http://api:3002/v2/crawl/x?skip=10', data: [{ metadata: { url: 'http://api:3002/page' } }] };
    expect(rewriteUrls(body, 'http://api:3002', 'https://crawl.example.com')).toBe(true);
    expect(body.url).toBe('https://crawl.example.com/v2/crawl/x');
    expect(body.next).toBe('https://crawl.example.com/v2/crawl/x?skip=10');
    expect(body.data[0]!.metadata.url).toBe('http://api:3002/page');
    expect(rewriteUrls({ url: 'https://example.com/a' }, 'http://api:3002', 'https://g')).toBe(false);
  });
});

describe('ledger periods', () => {
  it('uses UTC calendar months', () => {
    expect(periodOf(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11-01');
    expect(periodOf(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12-01');
    expect(periodEnd('2026-12-01')).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('config', () => {
  const base = { UPSTREAM_URL: 'http://api:3002', DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' };

  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.AUTH_PROVIDER).toBe('postgres');
    expect(c.RATE_LIMIT_FAIL_MODE).toBe('open');
  });

  it('treats empty strings (compose defaults) as unset', () => {
    const c = loadConfig({ ...base, PUBLIC_BASE_URL: '', STATIC_KEYS: '', RATE_SCRAPE_PER_MIN: '' });
    expect(c.PUBLIC_BASE_URL).toBeUndefined();
    expect(c.RATE_SCRAPE_PER_MIN).toBe(100);
  });

  it('never echoes values in errors', () => {
    const secret = 'postgres://user:hunter2@db';
    expect(() => loadConfig({ ...base, DATABASE_URL: secret, UPSTREAM_URL: 'ftp://nope' })).toThrow(/UPSTREAM_URL/);
    try {
      loadConfig({ ...base, DATABASE_URL: secret, STATIC_KEYS: '[{"key":"hunter2"}]' });
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });

  it('requires keys for the static provider', () => {
    expect(() => loadConfig({ ...base, AUTH_PROVIDER: 'static' })).toThrow(/STATIC_KEYS/);
    const k = generateKey().token;
    const c = loadConfig({ ...base, AUTH_PROVIDER: 'static', STATIC_KEYS: JSON.stringify([{ key: k, team: 'acme', monthlyCredits: 100 }]) });
    expect(c.STATIC_KEYS[0]).toMatchObject({ team: 'acme', monthlyCredits: 100, rateMultiplier: 1 });
  });
});
