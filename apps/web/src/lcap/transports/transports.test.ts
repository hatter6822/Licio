// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4b/15.5 — the client transports over the seam: the HTTPS anchor POSTs the
// exchange and returns the response; the WebTransport adapter round-trips over a bidi
// stream; the courier ferries via an out-of-band medium; and the registry assembles the
// set + runs `fallbackExchange` (server anchor last), so the same bytes flow through any
// carrier.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CourierTransport, InMemoryCourierMedium } from './courier.js';
import { HttpsTransport } from './https.js';
import { buildServerTransports, offlineExchange } from './registry.js';
import {
  isWebTransportSupported,
  type WebTransportLike,
  WebTransportTransport,
} from './webtransport.js';

function fetchReturning(bytes: Uint8Array, status = 200): typeof fetch {
  // Copy to a fresh ArrayBuffer-backed view so it is a valid BodyInit (TS 5.7+ narrows
  // a general Uint8Array out of BufferSource).
  return (async () => new Response(new Uint8Array(bytes), { status })) as unknown as typeof fetch;
}

describe('HttpsTransport (§22.6 anchor)', () => {
  it('POSTs the request and returns the response bytes', async () => {
    const t = new HttpsTransport({ fetchFn: fetchReturning(new Uint8Array([4, 5])) });
    await t.open();
    await t.send(new Uint8Array([1]));
    expect(await t.receive()).toEqual(new Uint8Array([4, 5]));
    expect(t.capabilities.serverMediated).toBe(true);
  });

  it('rejects a non-ok response', async () => {
    const t = new HttpsTransport({ fetchFn: fetchReturning(new Uint8Array(), 503) });
    await t.send(new Uint8Array([1]));
    await expect(t.receive()).rejects.toBeDefined();
  });
});

function fakeSession(response: Uint8Array): WebTransportLike {
  return {
    ready: Promise.resolve(),
    async createBidirectionalStream() {
      let read = false;
      return {
        writable: { getWriter: () => ({ async write() {}, async close() {} }) },
        readable: {
          getReader: () => ({
            async read() {
              if (read) return { done: true };
              read = true;
              return { value: response, done: false };
            },
          }),
        },
      };
    },
    close() {},
  };
}

describe('WebTransportTransport (§22.6 / WS-R.15.5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips a request over a bidirectional stream', async () => {
    const t = new WebTransportTransport(fakeSession(new Uint8Array([7, 8, 9])));
    await t.open();
    await t.send(new Uint8Array([1]));
    expect(await t.receive()).toEqual(new Uint8Array([7, 8, 9]));
  });

  it('feature-detects the platform API', () => {
    expect(isWebTransportSupported()).toBe(false); // not in node/jsdom
    vi.stubGlobal('WebTransport', class {});
    expect(isWebTransportSupported()).toBe(true);
  });
});

describe('CourierTransport (§22.5 / WS-R.15.4b)', () => {
  it('ferries the request to the outbox and resolves a receive on inbound delivery', async () => {
    const medium = new InMemoryCourierMedium();
    const t = new CourierTransport(medium);
    await t.send(new Uint8Array([1, 2]));
    expect(medium.outbox).toEqual([new Uint8Array([1, 2])]);

    const pending = t.receive();
    medium.deliverInbound(new Uint8Array([3, 4]));
    expect(await pending).toEqual(new Uint8Array([3, 4]));
    expect(t.capabilities.carriesPrivate).toBe(false); // public-only by default
  });
});

describe('transport registry (§22.6)', () => {
  it('always includes the HTTPS anchor; adds WebTransport only when supported + provided', () => {
    const base = buildServerTransports({ fetchFn: fetchReturning(new Uint8Array()) });
    expect(base.map((t) => t.capabilities.id)).toEqual(['https']);

    vi.stubGlobal('WebTransport', class {});
    const withWt = buildServerTransports({
      fetchFn: fetchReturning(new Uint8Array()),
      webTransportSession: fakeSession(new Uint8Array()),
    });
    expect(withWt.map((t) => t.capabilities.id).sort()).toEqual(['https', 'webtransport']);
    vi.unstubAllGlobals();
  });

  it('runs one exchange over the available transports and reports the carrier', async () => {
    const transports = buildServerTransports({ fetchFn: fetchReturning(new Uint8Array([9])) });
    const result = await offlineExchange(transports, new Uint8Array([1]));
    expect(result?.transport).toBe('https');
    expect(result?.response).toEqual(new Uint8Array([9]));
  });
});
