// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4b/15.5 — the client transports over the seam: the HTTPS anchor POSTs the
// exchange and returns the response; the WebTransport adapter round-trips over a bidi
// stream; the courier ferries via an out-of-band medium; and the registry assembles the
// set + runs `fallbackExchange` (server anchor last), so the same bytes flow through any
// carrier.
import { TransportUnavailableError } from '@licio/lcap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CourierMedium, CourierTransport, InMemoryCourierMedium } from './courier.js';
import { HttpsTransport } from './https.js';
import { buildServerTransports, loadWebrtcTransport, offlineExchange } from './registry.js';
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

  it('receive() before any send resolves null, and close() clears the pending exchange', async () => {
    const t = new HttpsTransport({ fetchFn: fetchReturning(new Uint8Array([1])) });
    await t.open();
    expect(await t.receive()).toBeNull(); // nothing sent yet
    await t.send(new Uint8Array([1]));
    await t.close();
    expect(await t.receive()).toBeNull(); // close() dropped the pending promise
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

  it('surfaces a failed session as TransportUnavailableError so the chain falls through', async () => {
    const failing: WebTransportLike = {
      ready: Promise.reject(new Error('handshake blocked')),
      async createBidirectionalStream() {
        throw new Error('unreachable');
      },
      close() {},
    };
    const t = new WebTransportTransport(failing);
    const opened = await t.open().then(
      () => null,
      (e: unknown) => e,
    );
    expect(opened).toBeInstanceOf(TransportUnavailableError);
    expect((opened as TransportUnavailableError).transport).toBe('webtransport');
    // Without a successfully opened stream, send refuses and receive yields null.
    await expect(t.send(new Uint8Array([1]))).rejects.toThrow(/stream not open/);
    expect(await t.receive()).toBeNull();
  });

  it('close() drops the stream and closes the underlying session', async () => {
    let closed = false;
    const session = fakeSession(new Uint8Array([1]));
    const t = new WebTransportTransport({
      ...session,
      close: () => {
        closed = true;
      },
    });
    await t.open();
    await t.close();
    expect(closed).toBe(true);
    expect(await t.receive()).toBeNull(); // stream dropped
  });
});

describe('CourierTransport (§22.5 / WS-R.15.4b)', () => {
  it('ferries the request to the outbox and resolves a receive on inbound delivery', async () => {
    const medium = new InMemoryCourierMedium();
    const t = new CourierTransport(medium);
    await t.open(); // always-open ferry (no handshake)
    await t.send(new Uint8Array([1, 2]));
    expect(medium.outbox).toEqual([new Uint8Array([1, 2])]);

    const pending = t.receive();
    medium.deliverInbound(new Uint8Array([3, 4]));
    expect(await pending).toEqual(new Uint8Array([3, 4]));
    expect(t.capabilities.carriesPrivate).toBe(false); // public-only by default
    await t.close(); // no teardown; outbox persists
  });

  it('returns an already-buffered inbound message immediately', async () => {
    const medium = new InMemoryCourierMedium();
    const t = new CourierTransport(medium);
    medium.deliverInbound(new Uint8Array([5, 6])); // arrives before receive()
    expect(await t.receive()).toEqual(new Uint8Array([5, 6]));
  });

  it('yields null on a non-notifying medium with nothing ferried in', async () => {
    // A medium without onInbound cannot wake a waiter, so receive resolves null at once.
    const medium: CourierMedium = {
      enqueueOutbound() {},
      takeInbound: () => null,
    };
    const t = new CourierTransport(medium);
    expect(await t.receive()).toBeNull();
  });

  it('resolves a pending receive with null when the abort signal fires', async () => {
    const medium = new InMemoryCourierMedium();
    const t = new CourierTransport(medium);
    const controller = new AbortController();
    const pending = t.receive(controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
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

  it('lazily loads the code-split WebRTC peer transport over a data channel', async () => {
    // Drives the §22.6 dynamic-import path: the registry pulls WebrtcTransport from the
    // code-split @licio/lcap-p2p chunk (kept out of the initial bundle, WS-R.15.8).
    const channel = {
      readyState: 'open' as const,
      send() {},
      close() {},
      onmessage: null,
      onclose: null,
    };
    const t = await loadWebrtcTransport(channel);
    expect(t.capabilities.id).toBe('webrtc');
    expect(t.capabilities.serverMediated).toBe(false);
    expect(t.capabilities.carriesPrivate).toBe(false);
    await t.open(); // the channel is open, so the seam considers it usable
  });
});
