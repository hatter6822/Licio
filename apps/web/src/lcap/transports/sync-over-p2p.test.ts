// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.10 — `syncRoomOverP2p` drives a fully BIDIRECTIONAL §16 exchange that MOVES content:
// a paired fake `RTCPeerConnection` + an in-memory server-blind signaling relay let an initiator
// and a responder converge on a data channel; the responder SERVES the block the initiator wants
// and the initiator INGESTS it.  When WebRTC is off, it back-stops at the HTTPS anchor and ingests
// the served response.  Two isolated fake-indexeddb stores stand in for the two devices.

import 'fake-indexeddb/auto';
import {
  buildExchangeResponse,
  buildPulse,
  cidFor,
  DEFAULT_BUDGET,
  encodeWithSchema,
  exchangeResponseV2Schema,
  repackHeldObjects,
  writeUvarint,
} from '@licio/lcap';
import type {
  ConnectableDataChannel,
  RtcIceCandidateInit,
  RtcPeerConnectionLike,
  RtcSessionDescriptionInit,
} from '@licio/lcap-p2p';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LCAP_DB_VERSION, LCAP_MIGRATIONS, LCAP_STORE, openLcapDb } from '../db.js';
import { putBlock, readBlockBytes } from '../store.js';
import { syncRoomOverP2p } from './sync-over-p2p.js';
import { runWebrtcBidirectionalExchange } from './webrtc-sync.js';

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

let initiatorDb: IDBDatabase;
let responderDb: IDBDatabase;

beforeEach(async () => {
  const s = Math.random().toString(36).slice(2);
  initiatorDb = await openLcapDb(`lcap_v2-syncp2p-A-${s}`, LCAP_DB_VERSION, LCAP_MIGRATIONS);
  responderDb = await openLcapDb(`lcap_v2-syncp2p-B-${s}`, LCAP_DB_VERSION, LCAP_MIGRATIONS);
});
afterEach(() => {
  initiatorDb.close();
  responderDb.close();
});

async function quarantineMissing(db: IDBDatabase, missing: string[]): Promise<void> {
  const tx = db.transaction(LCAP_STORE.quarantine, 'readwrite');
  tx.objectStore(LCAP_STORE.quarantine).put({
    cid: 'parent',
    reason: 'missing_dependency',
    firstSeen: 1,
    missingDeps: missing,
    byteSize: 0,
  });
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** A §16 exchange response whose `response_pack` serves `cids` from `held` (the anchor's reply). */
async function anchorResponseServing(
  held: Map<string, Uint8Array>,
  cids: string[],
): Promise<Uint8Array> {
  const repacked = await repackHeldObjects(
    async (cid) => {
      const bytes = held.get(cid);
      return bytes ? { kind: 'block', bytes } : undefined;
    },
    cids,
    1 << 20,
  );
  const pulse = buildPulse({
    nodeId: 'anchor',
    sessionNonce: new Uint8Array(16),
    transportProfile: 'https',
    privacyMode: 'public',
    budgets: { ...DEFAULT_BUDGET },
    supportedSuites: ['ES256'],
    supportedCompression: ['none'],
    supportedPackVersions: [2],
    checkpointFrontier: [],
    revocationFrontier: [{ scope: 'global', revocation_epoch: 0 }],
  });
  const response = buildExchangeResponse({
    pulse,
    status: 'ok',
    ...(repacked.pack !== undefined ? { responsePack: repacked.pack } : {}),
  });
  return encodeWithSchema(exchangeResponseV2Schema, response);
}

describe('WS-R.15.10 syncRoomOverP2p (bidirectional)', () => {
  it('moves content over WebRTC: the responder serves the block the initiator wants', async () => {
    const bytes = new Uint8Array([2, 4, 6, 8, 10, 12]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(responderDb, { blockCid, state: 'integrity_verified', size: bytes.length }, [
      bytes,
    ]);
    await quarantineMissing(initiatorDb, [blockCid]);

    const link = new FakeLink();
    const relay = makeRelayFetch();
    const p2p = await import('@licio/lcap-p2p');
    const signalKey = await p2p.importSignalKey(
      await (await import('./signal-key.js')).derivePublicSignalKeyBytes(ROOM),
    );
    const { createSignalClient } = await import('./p2p-signaling.js');
    const respSignals = createSignalClient({ apiBase: 'http://relay.test', fetchFn: relay });

    // The responder converges on the channel and runs the driver, serving from responderDb.
    const responderDone = p2p
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
      .then((channel) =>
        runWebrtcBidirectionalExchange({ db: responderDb, channel, timeoutMs: 5000 }),
      );

    const [result] = await Promise.all([
      syncRoomOverP2p({
        db: initiatorDb,
        roomIdHash: ROOM,
        selfPeerKey: 'alice',
        remotePeerKey: 'bob',
        initiator: true,
        privacy: { mode: 'standard', userEnabled: true },
        apiBase: 'http://relay.test',
        fetchFn: relay,
        rtcFactory: () => new FakePeer(link, 'initiator'),
        pollIntervalMs: 1,
        timeoutMs: 5000,
      }),
      responderDone,
    ]);

    expect(result?.transport).toBe('webrtc'); // the live peer carried it
    expect(result?.ingested?.blocks).toBe(1);
    expect(await readBlockBytes(initiatorDb, blockCid)).toEqual(bytes); // the initiator HOLDS it
  });

  it('falls back to the HTTPS anchor when WebRTC is off, and ingests the served response', async () => {
    const bytes = new Uint8Array([3, 1, 4, 1, 5, 9]);
    const blockCid = await cidFor('block', bytes);
    await quarantineMissing(initiatorDb, [blockCid]);
    const anchorBody = await anchorResponseServing(new Map([[blockCid, bytes]]), [blockCid]);

    const httpsFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/exchange')) return new Response(anchorBody as BodyInit, { status: 200 });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const result = await syncRoomOverP2p({
      db: initiatorDb,
      roomIdHash: ROOM,
      selfPeerKey: 'alice',
      remotePeerKey: 'bob',
      initiator: true,
      privacy: { mode: 'standard', userEnabled: false }, // off by default → anchor
      httpsConfig: { fetchFn: httpsFetch },
      rtcFactory: () => new FakePeer(new FakeLink(), 'initiator'),
      timeoutMs: 50,
    });
    expect(result?.transport).toBe('https');
    expect(result?.ingested?.blocks).toBe(1);
    expect(await readBlockBytes(initiatorDb, blockCid)).toEqual(bytes); // ingested from the anchor
  });
});
