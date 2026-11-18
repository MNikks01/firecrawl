import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, integration, reconcileUntilClosed, type Stack, startStack } from './harness.js';

describe.skipIf(!integration)('gateway in front of a Firecrawl-shaped upstream', () => {
  let s: Stack;
  let alice: { teamId: string; token: string; keyId: string };
  let bob: { teamId: string; token: string; keyId: string };

  beforeAll(async () => {
    s = await startStack();
    alice = await s.team('alice', 1000);
    bob = await s.team('bob', 1000);
  });
  afterAll(() => s.close());

  const upstreamHits = (pathPrefix: string) => s.mock.requests.filter((r) => r.path.startsWith(pathPrefix)).length;

  describe('authentication', () => {
    it('401s without a key, with a wrong key, and with a malformed key', async () => {
      const wrongSecret = alice.token.slice(0, -4) + 'AAAA';
      for (const token of [undefined, wrongSecret, 'fc-1234567890abcdef', 'Bearer']) {
        const r = await call(s.url, 'POST', '/v2/scrape', { token, body: { url: 'https://example.com' } });
        expect(r.status, String(token)).toBe(401);
        expect(r.json).toMatchObject({ success: false });
      }
    });

    it('a revoked key stops working as soon as the cache is invalidated', async () => {
      const carol = await s.team('carol', 100);
      expect((await call(s.url, 'POST', '/v2/map', { token: carol.token, body: { url: 'https://example.com' } })).status).toBe(200);
      await s.pool.query('update api_keys set revoked_at = now() where id = $1', [carol.keyId]);
      // Still cached (the TTL is 30s in this stack): this is what the pub/sub invalidation is for.
      expect((await call(s.url, 'POST', '/v2/map', { token: carol.token, body: { url: 'https://example.com' } })).status).toBe(200);
      s.auth.invalidate(carol.keyId);
      expect((await call(s.url, 'POST', '/v2/map', { token: carol.token, body: { url: 'https://example.com' } })).status).toBe(401);
    });

    it('never forwards the caller key to Firecrawl', async () => {
      const before = s.mock.authHeadersSeen;
      await call(s.url, 'POST', '/v2/scrape', { token: alice.token, body: { url: 'https://example.com' } });
      expect(s.mock.authHeadersSeen).toBe(before);
      const last = s.mock.requests.at(-1)!;
      expect(last.headers['x-request-id']).toBeTruthy();
      expect(last.headers['x-fcgw-team']).toBe(alice.teamId);
    });
  });

  describe('default deny', () => {
    it('404s admin, v1, team-wide listings and unknown routes without touching Firecrawl', async () => {
      const before = s.mock.requests.length;
      for (const [m, p] of [
        ['GET', '/admin/queues'],
        ['GET', '/admin/x/queues'],
        ['POST', '/v1/scrape'],
        ['GET', '/v2/crawl/ongoing'],
        ['GET', '/v2/crawl/active'],
        ['POST', '/v2/extract'],
        ['POST', '/V2/SCRAPE'],
        ['POST', '/v2/scrape/'],
      ] as const) {
        const r = await call(s.url, m, p, { token: alice.token, body: m === 'POST' ? {} : undefined });
        expect(r.status, `${m} ${p}`).toBe(404);
      }
      expect(s.mock.requests.length).toBe(before);
    });

    it('dot segments resolve before routing, so they cannot skip metering', async () => {
      const b0 = await s.used(alice.teamId);
      const r = await call(s.url, 'POST', '/v2/foo/../scrape', { token: alice.token, body: { url: 'https://example.com' } });
      expect(r.status).toBe(200);
      expect(s.mock.requests.at(-1)!.path).toBe('/v2/scrape');
      expect((await s.used(alice.teamId)).used).toBe(b0.used + 1);
    });
  });

  describe('metering', () => {
    it('charges what Firecrawl reports for a scrape (json format = 5)', async () => {
      const b0 = await s.used(alice.teamId);
      const r = await call(s.url, 'POST', '/v2/scrape', { token: alice.token, body: { url: 'https://example.com', formats: ['markdown', { type: 'json', prompt: 'x' }] } });
      expect(r.status).toBe(200);
      expect(await s.used(alice.teamId)).toEqual({ used: b0.used + 5, reserved: 0 });
    });

    it('a failed scrape costs nothing and releases its hold', async () => {
      const b0 = await s.used(alice.teamId);
      const r = await call(s.url, 'POST', '/v2/scrape', { token: alice.token, body: { url: 'https://fail.example.com' } });
      expect(r.status).toBe(500);
      expect(await s.used(alice.teamId)).toEqual({ used: b0.used, reserved: 0 });
    });

    it('charges search from its reported creditsUsed, and map at 1', async () => {
      const b0 = await s.used(alice.teamId);
      await call(s.url, 'POST', '/v2/search', { token: alice.token, body: { query: 'q', limit: 15 } });
      await call(s.url, 'POST', '/v2/map', { token: alice.token, body: { url: 'https://example.com' } });
      expect((await s.used(alice.teamId)).used).toBe(b0.used + 4 + 1);
    });

    it('402s once the month is spent, before calling Firecrawl', async () => {
      const dave = await s.team('dave', 3);
      for (let i = 0; i < 3; i++) expect((await call(s.url, 'POST', '/v2/scrape', { token: dave.token, body: { url: 'https://e.com' } })).status).toBe(200);
      const before = upstreamHits('/v2/scrape');
      const r = await call(s.url, 'POST', '/v2/scrape', { token: dave.token, body: { url: 'https://e.com' } });
      expect(r.status).toBe(402);
      expect(r.json.error).toMatch(/Insufficient credits/);
      expect(upstreamHits('/v2/scrape')).toBe(before);
    });

    it('concurrent requests cannot overspend a team', async () => {
      const erin = await s.team('erin', 25);
      const rs = await Promise.all(Array.from({ length: 60 }, () => call(s.url, 'POST', '/v2/scrape', { token: erin.token, body: { url: 'https://e.com' } })));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(25);
      expect(rs.filter((r) => r.status === 402)).toHaveLength(35);
      expect(await s.used(erin.teamId)).toEqual({ used: 25, reserved: 0 });
    });

    it('serves GET /v2/team/credit-usage in Firecrawl’s shape', async () => {
      const frank = await s.team('frank', 50);
      await call(s.url, 'POST', '/v2/scrape', { token: frank.token, body: { url: 'https://e.com' } });
      const r = await call(s.url, 'GET', '/v2/team/credit-usage', { token: frank.token });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ success: true, data: { remainingCredits: 49, planCredits: 50 } });
      expect(Date.parse(r.json.data.billingPeriodStart)).toBeLessThan(Date.parse(r.json.data.billingPeriodEnd));
    });
  });

  describe('job isolation', () => {
    it('only the creating team can read, page or cancel a crawl, and links point at the gateway', async () => {
      const c = await call(s.url, 'POST', '/v2/crawl', { token: alice.token, body: { url: 'https://example.com', limit: 12 } });
      expect(c.status).toBe(200);
      const id = c.json.id as string;
      expect(c.json.url).toBe(`${s.url}/v2/crawl/${id}`);

      const before = upstreamHits(`/v2/crawl/${id}`);
      for (const [m, p] of [
        ['GET', `/v2/crawl/${id}`],
        ['GET', `/v2/crawl/${id}/errors`],
        ['DELETE', `/v2/crawl/${id}`],
      ] as const) {
        const r = await call(s.url, m, p, { token: bob.token });
        expect(r.status, `${m} ${p}`).toBe(404);
        expect(r.json.error).toBe('Job not found');
      }
      expect(upstreamHits(`/v2/crawl/${id}`)).toBe(before);

      await new Promise((r) => setTimeout(r, 30));
      const own = await call(s.url, 'GET', `/v2/crawl/${id}?limit=5`, { token: alice.token });
      expect(own.status).toBe(200);
      expect(own.json.next).toBe(`${s.url}/v2/crawl/${id}?skip=5&limit=5`);
      const page2 = await call(s.url, 'GET', new URL(own.json.next).pathname + new URL(own.json.next).search, { token: alice.token });
      expect(page2.status).toBe(200);
      expect(page2.json.data).toHaveLength(5);
    });

    it('a job id from another team is indistinguishable from a made-up one', async () => {
      const made = await call(s.url, 'GET', '/v2/crawl/00000000-0000-0000-0000-000000000000', { token: bob.token });
      expect(made.status).toBe(404);
      expect(made.json).toEqual({ success: false, error: 'Job not found' });
    });

    it('batch scrape appendToId must be your own job', async () => {
      const b = await call(s.url, 'POST', '/v2/batch/scrape', { token: alice.token, body: { urls: ['https://a.com'] } });
      expect(b.status).toBe(200);
      const steal = await call(s.url, 'POST', '/v2/batch/scrape', { token: bob.token, body: { urls: ['https://b.com'], appendToId: b.json.id } });
      expect(steal.status).toBe(404);
      const own = await call(s.url, 'POST', '/v2/batch/scrape', { token: alice.token, body: { urls: ['https://c.com'], appendToId: b.json.id } });
      expect(own.status).toBe(200);
      expect(own.json.id).toBe(b.json.id);
    });

    it('a crawl is billed per document, exactly, even if the client never polls', async () => {
      const gina = await s.team('gina', 1000);
      const c = await call(s.url, 'POST', '/v2/crawl', { token: gina.token, body: { url: 'https://example.com', limit: 12 } });
      expect((await s.used(gina.teamId)).used).toBe(0); // creating a crawl is free; pages are not
      const closed = await reconcileUntilClosed(s, c.json.id);
      expect(closed).toMatchObject({ status: 'closed', close_reason: 'upstream_completed' });
      // 12 pages; documents 4 and 9 are 3-page PDFs (3 credits each). An estimate would say 12.
      expect(await s.used(gina.teamId)).toEqual({ used: 16, reserved: 0 });
    });
  });

  describe('rate limiting', () => {
    it('429s past the bucket with Retry-After and RateLimit headers, per team', async () => {
      const rs = await startStack({ rate: { scrape: 5 } });
      try {
        const t = await rs.team('hal', null);
        const u = await rs.team('ivy', null);
        const out = await Promise.all(Array.from({ length: 8 }, () => call(rs.url, 'POST', '/v2/map', { token: t.token, body: { url: 'https://e.com' } })));
        const statuses = out.map((r) => `${r.status}:${JSON.stringify(r.json).slice(0, 60)}`).join(' | ');
        expect(out.filter((r) => r.status === 200).length, statuses).toBe(5);
        expect(out.filter((r) => r.status === 429).length, statuses).toBe(3);
        const limited = out.find((r) => r.status === 429)!;
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
        expect(limited.headers.get('ratelimit-policy')).toBe('"scrape";q=5;w=60');
        expect(limited.headers.get('ratelimit')).toMatch(/^"scrape";r=0;t=\d+$/);
        expect(limited.json).toMatchObject({ success: false });
        expect((await call(rs.url, 'POST', '/v2/map', { token: u.token, body: { url: 'https://e.com' } })).status).toBe(200);
      } finally {
        await rs.close();
      }
    });
  });

  describe('upstream failures', () => {
    it('502 when Firecrawl is down, and the hold is released', async () => {
      const ds = await startStack({ upstreamUrl: 'http://127.0.0.1:1' });
      try {
        const t = await ds.team('jay', 10);
        const r = await call(ds.url, 'POST', '/v2/scrape', { token: t.token, body: { url: 'https://e.com' } });
        expect(r.status).toBe(502);
        expect(await ds.used(t.teamId)).toEqual({ used: 0, reserved: 0 });
      } finally {
        await ds.close();
      }
    });
  });
});
