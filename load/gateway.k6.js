// Load test for the gateway. Three questions, three scenarios, run one after another:
//
//   overhead   What latency does the gateway add? Same arrival rate straight at Firecrawl (the mock)
//              and through the gateway; compare the two distributions.
//   ratelimit  Does the token bucket admit exactly bucket + refill x time under concurrency?
//   quota      Can 50 concurrent clients overspend a 300-credit team? (Must be exactly 300.)
//
// Seed teams first:   node dist/src/bin/admin.js load-seed --out load/results/seed.json
// (SEED is resolved relative to this script; pass an absolute path to be safe.)
// Then:               k6 run -e SEED=load/results/seed.json load/gateway.k6.js
// Env: GATEWAY_URL (default http://localhost:3003), UPSTREAM_URL (default http://localhost:3002),
//      RATE (overhead req/s, default 200), RATE_SCRAPE_PER_MIN (gateway default 100).
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const GW = __ENV.GATEWAY_URL || 'http://localhost:3003';
const UP = __ENV.UPSTREAM_URL || 'http://localhost:3002';
const RATE = Number(__ENV.RATE || 200);
const PER_MIN = Number(__ENV.RATE_SCRAPE_PER_MIN || 100);
const seed = JSON.parse(open(__ENV.SEED || './results/seed.json'));

const OVERHEAD_S = 30;
const RL_S = 30;
const RL_RATE = 20;

const latDirect = new Trend('lat_direct', true);
const latGateway = new Trend('lat_gateway', true);
const admitted = new Counter('rl_admitted');
const limited = new Counter('rl_limited');
const quotaOk = new Counter('quota_ok');
const quotaRefused = new Counter('quota_refused');
const unexpected = new Counter('unexpected');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    direct: { executor: 'constant-arrival-rate', exec: 'direct', rate: RATE, timeUnit: '1s', duration: `${OVERHEAD_S}s`, preAllocatedVUs: 100, maxVUs: 400 },
    gateway: { executor: 'constant-arrival-rate', exec: 'gateway', rate: RATE, timeUnit: '1s', duration: `${OVERHEAD_S}s`, preAllocatedVUs: 100, maxVUs: 400, startTime: `${OVERHEAD_S + 2}s` },
    ratelimit: { executor: 'constant-arrival-rate', exec: 'ratelimit', rate: RL_RATE, timeUnit: '1s', duration: `${RL_S}s`, preAllocatedVUs: 20, startTime: `${2 * OVERHEAD_S + 4}s` },
    quota: { executor: 'constant-vus', exec: 'quota', vus: 50, duration: '10s', startTime: `${2 * OVERHEAD_S + RL_S + 6}s` },
  },
  thresholds: {
    unexpected: ['count==0'],
    // bucket (one minute's worth) + refill during the run, +-5% for scheduling jitter
    rl_admitted: [`count>=${Math.floor((PER_MIN + (PER_MIN / 60) * RL_S) * 0.95)}`, `count<=${Math.ceil((PER_MIN + (PER_MIN / 60) * RL_S) * 1.05)}`],
    quota_ok: ['count==300'],
  },
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max'],
};

const body = JSON.stringify({ url: 'https://example.com' });
const json = { 'content-type': 'application/json' };
const auth = (k) => ({ ...json, authorization: `Bearer ${k}` });

export function direct() {
  const r = http.post(`${UP}/v2/scrape`, body, { headers: json, tags: { name: 'direct' } });
  latDirect.add(r.timings.duration);
  if (r.status !== 200) unexpected.add(1, { where: 'direct', status: String(r.status) });
}

export function gateway() {
  const r = http.post(`${GW}/v2/scrape`, body, { headers: auth(seed.throughput), tags: { name: 'gateway' } });
  latGateway.add(r.timings.duration);
  if (r.status !== 200) unexpected.add(1, { where: 'gateway', status: String(r.status) });
}

export function ratelimit() {
  const r = http.post(`${GW}/v2/map`, body, { headers: auth(seed.ratelimited), tags: { name: 'ratelimit' } });
  if (r.status === 200) admitted.add(1);
  else if (r.status === 429 && Number(r.headers['Retry-After']) >= 1 && r.headers['Ratelimit-Policy']) limited.add(1);
  else unexpected.add(1, { where: 'ratelimit', status: String(r.status) });
}

export function quota() {
  const r = http.post(`${GW}/v2/scrape`, body, { headers: auth(seed.quota), tags: { name: 'quota' } });
  if (r.status === 200) quotaOk.add(1);
  else if (r.status === 402) quotaRefused.add(1);
  else unexpected.add(1, { where: 'quota', status: String(r.status) });
}

export function teardown() {
  const r = http.get(`${GW}/v2/team/credit-usage`, { headers: auth(seed.quota) });
  check(r, { 'quota team has exactly 0 credits left': (x) => x.status === 200 && x.json('data.remainingCredits') === 0 }) ||
    unexpected.add(1, { where: 'teardown' });
}

export function handleSummary(data) {
  const m = (name, stat) => data.metrics[name]?.values?.[stat];
  const line = (stat) => {
    const d = m('lat_direct', stat);
    const g = m('lat_gateway', stat);
    return `| ${stat} | ${d?.toFixed(1)} ms | ${g?.toFixed(1)} ms | +${(g - d).toFixed(1)} ms |`;
  };
  const expected = PER_MIN + (PER_MIN / 60) * RL_S;
  const md = [
    `## Load test (${new Date().toISOString()})`,
    '',
    `Overhead at ${RATE} req/s for ${OVERHEAD_S}s each (mock Firecrawl adds its own fixed latency to both):`,
    '',
    '| | direct to Firecrawl | through gateway | added |',
    '|---|---|---|---|',
    line('p(50)'),
    line('p(95)'),
    line('p(99)'),
    '',
    `Rate limit: ${m('rl_admitted', 'count')} admitted (expected ~${expected.toFixed(0)}), ${m('rl_limited', 'count')} clean 429s, at ${RL_RATE} req/s for ${RL_S}s.`,
    `Quota: ${m('quota_ok', 'count')} of 300 credits spent by 50 concurrent clients, ${m('quota_refused', 'count')} refused with 402.`,
    `Unexpected responses: ${m('unexpected', 'count') ?? 0}.`,
    '',
  ].join('\n');
  return { stdout: md, [__ENV.SUMMARY_OUT || 'load/results/summary.md']: md };
}
