import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/** Request headers never forwarded upstream. Authorization is the gateway's, not Firecrawl's. */
const DROP_REQUEST = new Set([
  'authorization',
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'cookie',
]);

/** Response headers not copied back. fetch already decoded the body, so encoding/length are stale. */
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie']);

export interface UpstreamRequest {
  method: string;
  /** Normalized path + query, already validated by the route table. */
  pathAndQuery: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
  requestId: string;
  principal?: { teamId: string; keyId: string };
}

export type UpstreamResponse =
  | { kind: 'buffered'; status: number; headers: Headers; body: Buffer; json: unknown | undefined }
  | { kind: 'stream'; status: number; headers: Headers; stream: Readable };

export class UpstreamError extends Error {
  constructor(
    readonly reason: 'timeout' | 'unreachable',
    message: string,
  ) {
    super(message);
  }
}

export class Upstream {
  private origin: string;

  constructor(
    baseUrl: string,
    private timeoutMs: number,
    private maxBuffered: number,
  ) {
    this.origin = new URL(baseUrl).origin;
  }

  /** The origin Firecrawl believes it is serving from (it builds `url`/`next` from its Host header). */
  get upstreamOrigin(): string {
    return this.origin;
  }

  async send(req: UpstreamRequest): Promise<UpstreamResponse> {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (v === undefined || DROP_REQUEST.has(lk) || lk.startsWith('x-forwarded-') || lk.startsWith('x-fcgw-')) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    headers.set('accept-encoding', 'identity');
    headers.set('x-request-id', req.requestId);
    // Informational only: Firecrawl ignores these, but they show up in its logs for correlation.
    if (req.principal) {
      headers.set('x-fcgw-team', req.principal.teamId);
      headers.set('x-fcgw-key', req.principal.keyId);
    }

    let res: Response;
    try {
      res = await fetch(this.origin + req.pathAndQuery, {
        method: req.method,
        headers,
        body: req.body && req.body.length > 0 && req.method !== 'GET' ? new Uint8Array(req.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError') throw new UpstreamError('timeout', `upstream did not answer within ${this.timeoutMs}ms`);
      throw new UpstreamError('unreachable', 'upstream unreachable');
    }

    const outHeaders = new Headers();
    res.headers.forEach((v, k) => {
      if (!DROP_RESPONSE.has(k)) outHeaders.set(k, v);
    });

    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (!res.body) return { kind: 'buffered', status: res.status, headers: outHeaders, body: Buffer.alloc(0), json: undefined };
    if (!isJson || (Number.isFinite(declared) && declared > this.maxBuffered)) {
      return { kind: 'stream', status: res.status, headers: outHeaders, stream: Readable.fromWeb(res.body as unknown as WebReadableStream) };
    }

    // Buffer up to the cap; past it, hand back what we have plus the rest as a stream.
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
      if (size > this.maxBuffered) {
        const head = Buffer.concat(chunks);
        const rest = Readable.from(
          (async function* () {
            yield head;
            for (;;) {
              const r = await reader.read();
              if (r.done) return;
              yield Buffer.from(r.value);
            }
          })(),
        );
        return { kind: 'stream', status: res.status, headers: outHeaders, stream: rest };
      }
    }
    const body = Buffer.concat(chunks);
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      json = undefined;
    }
    return { kind: 'buffered', status: res.status, headers: outHeaders, body, json };
  }
}

/**
 * Firecrawl builds `url` (async create) and `next` (status pagination) from its own Host header,
 * which is the internal address. Point them at the gateway so SDK pagination keeps working.
 * Only these two top-level fields are touched; scraped documents are left alone.
 */
export function rewriteUrls(json: unknown, upstreamOrigin: string, publicOrigin: string): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  const o = json as Record<string, unknown>;
  let changed = false;
  for (const field of ['url', 'next'] as const) {
    const v = o[field];
    if (typeof v !== 'string') continue;
    try {
      const u = new URL(v);
      if (u.origin === upstreamOrigin || u.origin === upstreamOrigin.replace(/^https:/, 'http:')) {
        o[field] = publicOrigin + u.pathname + u.search;
        changed = true;
      }
    } catch {
      /* not a URL */
    }
  }
  return changed;
}
