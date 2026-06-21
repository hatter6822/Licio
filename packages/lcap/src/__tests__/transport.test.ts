// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4b — the transport seam: HTTPS is forced last (the always-correct anchor),
// a public-only transport refuses non-public packs, the fallback chain skips failing
// transports and still succeeds via the anchor, and one exchange round opens/sends/
// receives/closes deterministically regardless of which transport carries it.

import { describe, expect, it } from 'vitest';
import {
  fallbackExchange,
  type LcapTransport,
  runExchangeRound,
  selectTransports,
  type TransportCapabilities,
  type TransportId,
  TransportUnavailableError,
  transportMayCarry,
} from '../transport/index.js';

function caps(id: TransportId, over: Partial<TransportCapabilities> = {}): TransportCapabilities {
  return {
    id,
    bidirectional: true,
    serverMediated: id === 'https' || id === 'webtransport',
    carriesPrivate: id === 'https' || id === 'webtransport',
    maxExchangeBytes: 1 << 20,
    latencyClass: 'medium',
    ...over,
  };
}

/** A scripted in-memory transport: returns `response` on receive, logs the call order. */
function fakeTransport(
  id: TransportId,
  opts: { response?: Uint8Array | null; failOpen?: boolean; log?: string[] } = {},
): LcapTransport {
  const log = opts.log ?? [];
  return {
    capabilities: caps(id),
    async open() {
      log.push(`${id}:open`);
      if (opts.failOpen) throw new TransportUnavailableError(id);
    },
    async send() {
      log.push(`${id}:send`);
    },
    async receive() {
      log.push(`${id}:receive`);
      return opts.response === undefined ? new Uint8Array([1]) : opts.response;
    },
    async close() {
      log.push(`${id}:close`);
    },
  };
}

describe('transportMayCarry — public-only gate (§21.4/§26.4)', () => {
  it('lets any transport carry a public pack but gates non-public to carriesPrivate', () => {
    const peer = caps('webrtc', { carriesPrivate: false });
    const server = caps('https', { carriesPrivate: true });
    expect(transportMayCarry(peer, 'public')).toBe(true);
    expect(transportMayCarry(peer, 'contains_in_room_metadata')).toBe(false);
    expect(transportMayCarry(peer, 'contains_private_encrypted')).toBe(false);
    expect(transportMayCarry(server, 'contains_in_room_metadata')).toBe(true);
  });
});

describe('selectTransports — server anchor forced last (§22.6)', () => {
  it('orders optional transports by preference and puts server-mediated ones last', () => {
    const https = fakeTransport('https');
    const webrtc = fakeTransport('webrtc');
    const webtransport = fakeTransport('webtransport'); // server-mediated
    const ordered = selectTransports([https, webtransport, webrtc]).map((t) => t.capabilities.id);
    // webrtc (optional) leads; the two server-mediated anchors trail.
    expect(ordered[0]).toBe('webrtc');
    expect(ordered.slice(1).every((id) => id === 'https' || id === 'webtransport')).toBe(true);
  });
});

describe('runExchangeRound — deterministic open/send/receive/close', () => {
  it('drives the channel in order and returns the response', async () => {
    const log: string[] = [];
    const t = fakeTransport('webrtc', { response: new Uint8Array([9]), log });
    const res = await runExchangeRound(t, new Uint8Array([1]));
    expect(res).toEqual(new Uint8Array([9]));
    expect(log).toEqual(['webrtc:open', 'webrtc:send', 'webrtc:receive', 'webrtc:close']);
  });

  it('always closes even when receive yields null', async () => {
    const log: string[] = [];
    const t = fakeTransport('webrtc', { response: null, log });
    expect(await runExchangeRound(t, new Uint8Array([1]))).toBeNull();
    expect(log.at(-1)).toBe('webrtc:close');
  });
});

describe('fallbackExchange — skips failures, succeeds via the anchor', () => {
  it('falls through a failing optional transport to the https anchor', async () => {
    const log: string[] = [];
    const webrtc = fakeTransport('webrtc', { failOpen: true, log });
    const https = fakeTransport('https', { response: new Uint8Array([7]), log });
    const result = await fallbackExchange([https, webrtc], new Uint8Array([1]));
    expect(result?.transport).toBe('https');
    expect(result?.response).toEqual(new Uint8Array([7]));
    // webrtc was tried first (and failed), https anchored the success.
    expect(log[0]).toBe('webrtc:open');
  });

  it('returns null when every transport fails', async () => {
    const a = fakeTransport('webrtc', { failOpen: true });
    const b = fakeTransport('https', { failOpen: true });
    expect(await fallbackExchange([a, b], new Uint8Array([1]))).toBeNull();
  });
});
