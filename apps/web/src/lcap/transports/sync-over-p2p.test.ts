// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.6 — the runtime consumer (`syncRoomOverP2p`) that drives a live WebRTC exchange.
// A paired fake `RTCPeerConnection` + an in-memory server-blind signaling relay (over the
// injected fetch) let two `syncRoomOverP2p` calls converge on a data channel, exchange a
// MULTI-BLOCK / LARGE (multi-fragment) LCAP pack through the registry + the §22.6 anchor-
// last selection, and prove the public-only carriage gate refuses a private pack here.

import { writeUvarint } from '@licio/lcap';
import type {
  ConnectableDataChannel,
  RtcIceCandidateInit,
  RtcPeerConnectionLike,
  RtcSessionDescriptionInit,
} from '@licio/lcap-p2p';
import { describe, expect, it } from 'vitest';
import { derivePublicSignalKeyBytes } from './signal-key.js';
import { syncRoomOverP2p } from './sync-over-p2p.js';

// --- a paired fake data channel (mirrors connect.test.ts in @licio/lcap-p2p) --------
class FakeChannel implements ConnectableDataChannel {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  binaryType = 'blob';
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  peer: FakeChannel | null = null;
  send(data: Uint8Array): void {
    const peer = this.peer;
    if (peer?.readyState !== 'open') return;
    const copy = data.slice();
    queueMicrotask(() => peer.onmessage?.({ data: copy.buffer }));
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    queueMicrotask(() => this.onclose?.());
  }
  open(): void {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    queueMicrotask(() => this.onopen?.());
  }
}

class FakeLink {
  aChannel: FakeChannel | null = null;
  bChannel: FakeChannel | null = null;
  answerSetOnInitiator = false;
  maybeOpen(): void {
    if (this.aChannel && this.bChannel && this.answerSetOnInitiator) {
      this.aChannel.peer = this.bChannel;
      this.bChannel.peer = this.aChannel;
      this.aChannel.open();
      this.bChannel.open();
    }
  }
}

class FakePeer implements RtcPeerConnectionLike {
  onicecandidate: ((event: { candidate: RtcIceCandidateInit | null }) => void) | null = null;
  ondatachannel: ((event: { channel: ConnectableDataChannel }) => void) | null = null;
  constructor(
    private readonly link: FakeLink,
    private readonly role: 'initiator' | 'responder',
  ) {}
  createDataChannel(): ConnectableDataChannel {
    const ch = new FakeChannel();
    this.link.aChannel = ch;
    return ch;
  }
  async createOffer(): Promise<RtcSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\nfake-offer' };
  }
  async createAnswer(): Promise<RtcSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0\r\nfake-answer' };
  }
  async setLocalDescription(): Promise<void> {
    queueMicrotask(() =>
      this.onicecandidate?.({
        candidate: { candidate: `candidate:${this.role}`, sdpMid: '0', sdpMLineIndex: 0 },
      }),
    );
    queueMicrotask(() => this.onicecandidate?.({ candidate: null }));
  }
  async setRemoteDescription(description: RtcSessionDescriptionInit): Promise<void> {
    if (this.role === 'responder' && description.type === 'offer') {
      const ch = new FakeChannel();
      this.link.bChannel = ch;
      queueMicrotask(() => this.ondatachannel?.({ channel: ch }));
    }
    if (this.role === 'initiator' && description.type === 'answer') {
      this.link.answerSetOnInitiator = true;
      this.link.maybeOpen();
    }
  }
  async addIceCandidate(): Promise<void> {}
  close(): void {}
}

// --- an in-memory server-blind signaling relay over the injected fetch --------------
// Models POST /api/lcap/v2/p2p/signal?to=<peer> (store the opaque body) and
// POST /api/lcap/v2/p2p/signal/poll?peer=<self> (drain, framed as the server does).
function makeRelayFetch(): typeof fetch {
  const mailboxes = new Map<string, Uint8Array[]>();
  const frame = (blobs: Uint8Array[]): Uint8Array => {
    const parts: Uint8Array[] = [writeUvarint(blobs.length)];
    for (const b of blobs) parts.push(writeUvarint(b.length), b);
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://relay.test');
    if (url.pathname.endsWith('/p2p/signal/poll')) {
      const self = url.searchParams.get('peer') ?? '';
      const box = mailboxes.get(self) ?? [];
      mailboxes.set(self, []);
      return new Response(frame(box) as BodyInit, { status: 200 });
    }
    if (url.pathname.endsWith('/p2p/signal')) {
      const to = url.searchParams.get('to') ?? '';
      const body = new Uint8Array((init?.body as ArrayBuffer) ?? new ArrayBuffer(0));
      const box = mailboxes.get(to) ?? [];
      box.push(body);
      mailboxes.set(to, box);
      return new Response(null, { status: 202 });
    }
    throw new Error(`unexpected relay fetch: ${url.pathname}`);
  }) as unknown as typeof fetch;
}

const ROOM = new Uint8Array(32).fill(11);

describe('WS-R.15.6 signal-key provisioning (public)', () => {
  it('derives a deterministic 32-byte key from the public room hash (both peers agree)', async () => {
    const k1 = await derivePublicSignalKeyBytes(ROOM);
    const k2 = await derivePublicSignalKeyBytes(ROOM);
    expect(k1.length).toBe(32);
    expect(k1).toEqual(k2); // any participant derives the SAME key from the public hash
    const other = await derivePublicSignalKeyBytes(new Uint8Array(32).fill(12));
    expect(other).not.toEqual(k1); // a different room → a different key
  });
});

describe('WS-R.15.6 syncRoomOverP2p (runtime consumer)', () => {
  it('exchanges a MULTI-BLOCK / large pack end-to-end over the live transport + selection', async () => {
    const link = new FakeLink();

    // The responder runs first, parking on its poll loop; it will receive the offer and
    // answer it.  Its `requestMessage` is what flows back to the initiator as the response
    // (the responder's exchange round: open → send the request → receive → close).
    // We model the §16 round as: initiator sends its pack → responder's WebrtcTransport
    // receives it; the responder sends a large response pack the initiator's round returns.
    //
    // `syncRoomOverP2p` uses `runExchangeRound` semantics (send the request, await the
    // response).  To exercise BOTH directions we run the responder as a manual peer that
    // echoes a large response after receiving the initiator's request.

    const relay = makeRelayFetch();

    // Build the responder transport directly via the lcap-p2p connect path so we can drive
    // its receive→send (the registry consumer only models the initiator's round).
    const p2p = await import('@licio/lcap-p2p');
    const signalKeyBytes = await derivePublicSignalKeyBytes(ROOM);
    const signalKey = await p2p.importSignalKey(signalKeyBytes);
    const { createSignalClient } = await import('./p2p-signaling.js');
    const responderSignals = createSignalClient({ apiBase: 'http://relay.test', fetchFn: relay });

    const responderChannelP = p2p.connectWebrtc({
      decision: p2p.decideWebrtc({ mode: 'standard', userEnabled: true }),
      signalKey,
      roomIdHash: ROOM,
      selfPeerKey: 'bob',
      remotePeerKey: 'alice',
      initiator: false,
      postSignal: responderSignals.postSignal,
      pollSignal: responderSignals.pollSignal,
      pollIntervalMs: 1,
      timeoutMs: 5000,
      rtcFactory: () => new FakePeer(link, 'responder'),
    });

    const largeResponse = new Uint8Array(40 * 1024);
    for (let i = 0; i < largeResponse.length; i++) largeResponse[i] = (i * 13 + 5) & 0xff;

    // Once the responder channel opens, wrap it and echo a large response upon receiving.
    const responderDone = responderChannelP.then(async (ch) => {
      const t = new p2p.WebrtcTransport(ch);
      await t.open();
      const incoming = await t.receive();
      expect(incoming).not.toBeNull();
      await t.send(largeResponse);
      // keep the channel open long enough for the initiator to read the response
      return incoming;
    });

    const requestPack = new Uint8Array(20 * 1024); // multi-fragment request
    for (let i = 0; i < requestPack.length; i++) requestPack[i] = (i * 7 + 1) & 0xff;

    const result = await syncRoomOverP2p({
      roomIdHash: ROOM,
      selfPeerKey: 'alice',
      remotePeerKey: 'bob',
      initiator: true,
      requestMessage: requestPack,
      privacy: { mode: 'standard', userEnabled: true },
      apiBase: 'http://relay.test',
      fetchFn: relay,
      rtcFactory: () => new FakePeer(link, 'initiator'),
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });

    const incoming = await responderDone;
    expect(incoming).toEqual(requestPack); // the responder received the full request pack
    expect(result).not.toBeNull();
    expect(result?.transport).toBe('webrtc'); // the live peer carried it (not the anchor)
    expect(result?.response).toEqual(largeResponse); // large multi-fragment response intact
  });

  it('falls back to the HTTPS anchor when WebRTC is off by default', async () => {
    // WebRTC is off by default (userEnabled: false), so the consumer must use the anchor.
    const anchorBody = new Uint8Array([9, 9, 9]);
    const httpsFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/exchange')) return new Response(anchorBody as BodyInit, { status: 200 });
      // signaling endpoints are never hit because WebRTC is refused before connecting
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const result = await syncRoomOverP2p({
      roomIdHash: ROOM,
      selfPeerKey: 'alice',
      remotePeerKey: 'bob',
      initiator: true,
      requestMessage: new Uint8Array([1, 2]),
      privacy: { mode: 'standard', userEnabled: false }, // off by default
      httpsConfig: { fetchFn: httpsFetch },
      rtcFactory: () => new FakePeer(new FakeLink(), 'initiator'),
      timeoutMs: 50,
    });
    expect(result?.transport).toBe('https'); // anchor-last fallback carried it
    expect(result?.response).toEqual(anchorBody);
  });

  it('the public-only carriage gate refuses a private pack over the WebRTC transport', async () => {
    // A non-public pack must NEVER ride the public-only WebRTC peer transport: the carriage
    // gate skips it, so the exchange falls back to the HTTPS anchor (which may carry it).
    const link = new FakeLink();
    const anchorBody = new Uint8Array([7]);
    // ONE shared relay so the two peers' signaling actually routes (a fresh relay per call
    // would lose every message); the same fetch answers the HTTPS /exchange anchor.
    const relay = makeRelayFetch();
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://relay.test');
      if (url.pathname.includes('/exchange')) {
        return new Response(anchorBody as BodyInit, { status: 200 });
      }
      // The signaling relay (so the WebRTC channel still OPENS — the gate, not connectivity,
      // is what keeps the private pack off it).
      return relay(input, init);
    }) as unknown as typeof fetch;

    // Open a responder so the WebRTC channel is genuinely established and would be tried
    // first if the gate did not skip it.
    const p2p = await import('@licio/lcap-p2p');
    const signalKey = await p2p.importSignalKey(await derivePublicSignalKeyBytes(ROOM));
    const { createSignalClient } = await import('./p2p-signaling.js');
    const respSignals = createSignalClient({ apiBase: 'http://relay.test', fetchFn });
    const responderP: Promise<InstanceType<typeof p2p.WebrtcTransport>> = p2p
      .connectWebrtc({
        decision: p2p.decideWebrtc({ mode: 'standard', userEnabled: true }),
        signalKey,
        roomIdHash: ROOM,
        selfPeerKey: 'bob',
        remotePeerKey: 'alice',
        initiator: false,
        postSignal: respSignals.postSignal,
        pollSignal: respSignals.pollSignal,
        pollIntervalMs: 1,
        timeoutMs: 5000,
        rtcFactory: () => new FakePeer(link, 'responder'),
      })
      .then((ch) => new p2p.WebrtcTransport(ch));

    const result = await syncRoomOverP2p({
      roomIdHash: ROOM,
      selfPeerKey: 'alice',
      remotePeerKey: 'bob',
      initiator: true,
      requestMessage: new Uint8Array([1, 2, 3]),
      privacyLabel: 'contains_private_encrypted', // NON-public → gate skips WebRTC
      privacy: { mode: 'standard', userEnabled: true },
      apiBase: 'http://relay.test',
      httpsConfig: { fetchFn, exchangeUrl: 'http://relay.test/api/lcap/v2/exchange' },
      fetchFn,
      rtcFactory: () => new FakePeer(link, 'initiator'),
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });

    const responderTransport = await responderP;
    await responderTransport.close();
    // The private pack rode the HTTPS anchor, NOT the public-only WebRTC peer transport.
    expect(result?.transport).toBe('https');
    expect(result?.response).toEqual(anchorBody);
  });
});
