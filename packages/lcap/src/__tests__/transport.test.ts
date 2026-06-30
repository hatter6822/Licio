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

describe('seam security + stability (PUB-SEAM-4)', () => {
  it('refuses a NON-PUBLIC pack on public-only transports — null + NOT a single open()', async () => {
    const log: string[] = [];
    const webrtc = fakeTransport('webrtc', { log }); // carriesPrivate:false
    const courier = fakeTransport('courier', { log }); // carriesPrivate:false
    const result = await fallbackExchange(
      [webrtc, courier],
      new Uint8Array([1]),
      undefined,
      undefined,
      'contains_in_room_metadata',
    );
    expect(result).toBeNull();
    expect(log).toEqual([]); // the privacy invariant: no transport was even opened
  });

  it('orders webtransport before https (both server-mediated anchors)', () => {
    const https = fakeTransport('https');
    const webtransport = fakeTransport('webtransport');
    expect(selectTransports([https, webtransport]).map((t) => t.capabilities.id)).toEqual([
      'webtransport',
      'https',
    ]);
  });

  it('is stable with duplicate + unranked transport ids (anchor still last)', () => {
    const a = fakeTransport('webrtc');
    const b = fakeTransport('webrtc'); // duplicate id
    const unranked = fakeTransport('qr'); // not in DEFAULT_TRANSPORT_PREFERENCE
    const https = fakeTransport('https');
    const ordered = selectTransports([https, a, b, unranked]).map((t) => t.capabilities.id);
    expect(ordered.at(-1)).toBe('https'); // the server anchor is still forced last
    expect(ordered.filter((id) => id === 'webrtc')).toHaveLength(2); // both duplicates retained
    expect(ordered).toContain('qr');
  });

  it('closes a transport whose send throws AFTER a successful open (PUB-SEAM-3)', async () => {
    const log: string[] = [];
    const t: LcapTransport = {
      capabilities: caps('webrtc'),
      async open() {
        log.push('open');
      },
      async send() {
        log.push('send');
        throw new Error('send failed');
      },
      async receive() {
        return null;
      },
      async close() {
        log.push('close');
      },
    };
    await expect(runExchangeRound(t, new Uint8Array([1]))).rejects.toThrow('send failed');
    expect(log).toEqual(['open', 'send', 'close']); // close ran despite the send throw
  });

  it('does NOT close a transport whose open throws (nothing was opened)', async () => {
    const log: string[] = [];
    const t: LcapTransport = {
      capabilities: caps('webrtc'),
      async open() {
        log.push('open');
        throw new TransportUnavailableError('webrtc');
      },
      async send() {
        log.push('send');
      },
      async receive() {
        return null;
      },
      async close() {
        log.push('close');
      },
    };
    await expect(runExchangeRound(t, new Uint8Array([1]))).rejects.toThrow();
    expect(log).toEqual(['open']); // a throwing open releases its own resources — no close()
  });
});

describe('fallbackExchange — skips failures, succeeds via the anchor', () => {
  it('falls through a failing optional transport to the https anchor', async () => {
    const log: string[] = [];
    const webrtc = fakeTransport('webrtc', { failOpen: true, log });
    const https = fakeTransport('https', { response: new Uint8Array([7]), log });
    // 'public' so the public-only webrtc transport is tried (and fails) before the anchor; an
    // OMITTED label now fails closed and would skip webrtc entirely (PUB-SEAM-1).
    const result = await fallbackExchange(
      [https, webrtc],
      new Uint8Array([1]),
      undefined,
      undefined,
      'public',
    );
    expect(result?.transport).toBe('https');
    expect(result?.response).toEqual(new Uint8Array([7]));
    // webrtc was tried first (and failed), https anchored the success.
    expect(log[0]).toBe('webrtc:open');
  });

  it('fails closed on an OMITTED label: a non-public-capable transport is skipped (PUB-SEAM-1)', async () => {
    const log: string[] = [];
    const webrtc = fakeTransport('webrtc', { response: new Uint8Array([7]), log }); // public-only
    const https = fakeTransport('https', { response: new Uint8Array([9]), log }); // carriesPrivate
    // No privacyLabel ⇒ treated as NON-PUBLIC ⇒ webrtc (carriesPrivate:false) is skipped, and only
    // the anchor carries it.  webrtc.open() is NEVER called.
    const result = await fallbackExchange([webrtc, https], new Uint8Array([1]));
    expect(result?.transport).toBe('https');
    expect(log).not.toContain('webrtc:open');
  });

  it('returns null when every transport fails', async () => {
    const a = fakeTransport('webrtc', { failOpen: true });
    const b = fakeTransport('https', { failOpen: true });
    expect(await fallbackExchange([a, b], new Uint8Array([1]))).toBeNull();
  });

  it('skips a public-only transport for a non-public pack (carriage gate)', async () => {
    const log: string[] = [];
    const webrtc = fakeTransport('webrtc', { response: new Uint8Array([5]), log }); // carriesPrivate:false
    const https = fakeTransport('https', { response: new Uint8Array([7]), log }); // carriesPrivate:true
    const result = await fallbackExchange(
      [https, webrtc],
      new Uint8Array([1]),
      undefined,
      undefined,
      'contains_in_room_metadata', // a non-public pack
    );
    // The peer carrier is never even opened; the private bytes ride only the anchor.
    expect(result?.transport).toBe('https');
    expect(log.some((entry) => entry.startsWith('webrtc'))).toBe(false);
  });
});
