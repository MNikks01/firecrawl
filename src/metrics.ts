/**
 * Minimal Prometheus text exposition: counters and one latency histogram.
 * Enough to alert on auth failures, 429s, settle failures and upstream latency
 * without pulling in a metrics library.
 */
type Labels = Record<string, string | number>;

const key = (name: string, labels: Labels) => {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
};

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

export class Metrics {
  private counters = new Map<string, number>();
  private help = new Map<string, string>();
  private hist = new Map<string, { buckets: number[]; sum: number; count: number; name: string; labels: Labels }>();

  inc(name: string, labels: Labels = {}, by = 1, help?: string): void {
    if (help) this.help.set(name, help);
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  observeMs(name: string, labels: Labels, ms: number): void {
    const k = key(name, labels);
    let h = this.hist.get(k);
    if (!h) {
      h = { buckets: BUCKETS_MS.map(() => 0), sum: 0, count: 0, name, labels };
      this.hist.set(k, h);
    }
    BUCKETS_MS.forEach((b, i) => {
      if (ms <= b) h!.buckets[i]! += 1;
    });
    h.sum += ms;
    h.count += 1;
  }

  get(name: string, labels: Labels = {}): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const [k, v] of [...this.counters].sort()) {
      const name = k.split('{')[0]!;
      if (!seen.has(name)) {
        seen.add(name);
        if (this.help.has(name)) lines.push(`# HELP ${name} ${this.help.get(name)}`);
        lines.push(`# TYPE ${name} counter`);
      }
      lines.push(`${k} ${v}`);
    }
    for (const h of this.hist.values()) {
      if (!seen.has(h.name)) {
        seen.add(h.name);
        lines.push(`# TYPE ${h.name} histogram`);
      }
      BUCKETS_MS.forEach((b, i) => lines.push(`${key(h.name + '_bucket', { ...h.labels, le: b })} ${h.buckets[i]}`));
      lines.push(`${key(h.name + '_bucket', { ...h.labels, le: '+Inf' })} ${h.count}`);
      lines.push(`${key(h.name + '_sum', h.labels)} ${h.sum}`);
      lines.push(`${key(h.name + '_count', h.labels)} ${h.count}`);
    }
    return lines.join('\n') + '\n';
  }
}
