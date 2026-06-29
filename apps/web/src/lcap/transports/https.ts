// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The HTTPS exchange transport (OFFLINE_SPEC §22.6) — the always-correct anchor every
// fallback chain ends with (`serverMediated: true`).  It carries one §16 exchange as a
// single request→response over `fetch` to the server's `/api/lcap/v2/exchange`, so the
// wire protocol + validation are identical to every other transport (no parallel
// model).  `send` initiates the POST; `receive` awaits its bytes.  fetch is injectable
// so the adapter is unit-testable; the live path uses the platform `fetch` with the
// session cookie.

import type { LcapTransport, TransportCapabilities } from '@licio/lcap';
import { TransportUnavailableError } from '@licio/lcap';

export const HTTPS_CAPABILITIES: TransportCapabilities = {
  id: 'https',
  bidirectional: true,
  serverMediated: true,
  carriesPrivate: true, // the server is the trust anchor; it may carry any visibility
  maxExchangeBytes: 64 * 1024 * 1024,
  latencyClass: 'medium',
};

export interface HttpsTransportConfig {
  /** The exchange endpoint (default the same-origin `/api/lcap/v2/exchange`). */
  readonly exchangeUrl?: string;
  /** Injectable fetch (defaults to the platform `fetch`). */
  readonly fetchFn?: typeof fetch;
}

/**
 * Read a response body, enforcing the per-exchange byte ceiling.  `response.arrayBuffer()`
 * is UNBOUNDED — a compromised/misbehaving endpoint could stream gigabytes and OOM the tab
 * before any §27 cap (which only fires inside `readPack`, i.e. after the whole body is in
 * memory) bit.  This streams the body and aborts as soon as the running total exceeds `cap`,
 * with an early reject on a declared `content-length` over the cap.
 */
async function readCappedResponse(response: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) {
    throw new TransportUnavailableError(
      'https',
      `response of ${declared} bytes exceeds the ${cap}-byte cap`,
    );
  }
  const body = response.body;
  if (!body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.length > cap) {
      throw new TransportUnavailableError('https', `response exceeds the ${cap}-byte cap`);
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new TransportUnavailableError('https', `response exceeds the ${cap}-byte cap`);
      }
      chunks.push(value);
    }
    if (done) break;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class HttpsTransport implements LcapTransport {
  readonly capabilities = HTTPS_CAPABILITIES;
  private readonly exchangeUrl: string;
  private readonly fetchFn: typeof fetch;
  private pending: Promise<Uint8Array | null> | null = null;
  /** Captured at `open` so `send`'s `fetch` is actually cancellable (the seam threads it). */
  private signal: AbortSignal | undefined;

  constructor(config: HttpsTransportConfig = {}) {
    this.exchangeUrl = config.exchangeUrl ?? '/api/lcap/v2/exchange';
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async open(signal?: AbortSignal): Promise<void> {
    // No handshake; reachability is proven by the request itself.  Keep the abort signal so
    // a cancelled/Stopped sync does not still upload the request `push_pack` to the server.
    this.signal = signal;
  }

  async send(message: Uint8Array): Promise<void> {
    if (this.signal?.aborted) {
      throw new TransportUnavailableError('https', 'aborted before send');
    }
    const cap = this.capabilities.maxExchangeBytes;
    this.pending = this.fetchFn(this.exchangeUrl, {
      method: 'POST',
      body: message as BodyInit,
      headers: { 'content-type': 'application/octet-stream' },
      credentials: 'same-origin',
      ...(this.signal ? { signal: this.signal } : {}),
    }).then(async (response) => {
      if (!response.ok) throw new TransportUnavailableError('https', `status ${response.status}`);
      return readCappedResponse(response, cap);
    });
  }

  async receive(): Promise<Uint8Array | null> {
    if (!this.pending) return null;
    return this.pending;
  }

  async close(): Promise<void> {
    this.pending = null;
  }
}
