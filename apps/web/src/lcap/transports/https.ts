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

export class HttpsTransport implements LcapTransport {
  readonly capabilities = HTTPS_CAPABILITIES;
  private readonly exchangeUrl: string;
  private readonly fetchFn: typeof fetch;
  private pending: Promise<Uint8Array | null> | null = null;

  constructor(config: HttpsTransportConfig = {}) {
    this.exchangeUrl = config.exchangeUrl ?? '/api/lcap/v2/exchange';
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async open(): Promise<void> {
    // No handshake; reachability is proven by the request itself.
  }

  async send(message: Uint8Array): Promise<void> {
    this.pending = this.fetchFn(this.exchangeUrl, {
      method: 'POST',
      body: message as BodyInit,
      headers: { 'content-type': 'application/octet-stream' },
      credentials: 'same-origin',
    }).then(async (response) => {
      if (!response.ok) throw new TransportUnavailableError('https', `status ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
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
