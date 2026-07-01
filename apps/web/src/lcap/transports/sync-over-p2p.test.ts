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

/** Put a PUBLIC record referencing `blockCid` so the block is shareable (an orphan block is not). */
async function putPublicRecordWithBlock(db: IDBDatabase, blockCid: string): Promise<void> {
  const lcap = await import('@licio/lcap');
  const body = lcap.encodeContributionEvent({
    record_version: 2,
    kind: 'contribution_event',
    event_type: 'post',
    home_room_id: 'room-1',
    visibility_scope: 'public',
    author_account_id: 'a',
    author_device_id: 'd',
    author_device_key_id: 'k',
    device_seq: 1,
    capability_cid: await lcap.cidFor('record', new Uint8Array([0])),
    policy_epoch_claim: 0,
    revocation_epoch_claim: 0,
    client_nonce: new Uint8Array([1]),
    priority: 2,
    body_block_cid: blockCid, // referenced in the SIGNED body so the share closure derives it (#O)
  });
  const recordCid = await lcap.cidFor('record', body);
  const tx = db.transaction(LCAP_STORE.records, 'readwrite');
  tx.objectStore(LCAP_STORE.records).put({
    recordCid,
    body,
    kind: 'contribution_event',
    lane: 'C0',
    priority: 2,
    roomHash: '',
    state: 'integrity_verified',
    size: body.length,
    deps: [blockCid],
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
    await putPublicRecordWithBlock(responderDb, blockCid); // block reachable from a public record
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

  it('a served-only WebRTC round (we served the peer, ingested nothing) returns webrtc, no anchor (#BB)', async () => {
    // The INITIATOR holds the block + has NO gaps of its own; the RESPONDER wants it.  The initiator
    // SERVES the peer (served=true) but ingests nothing — a reachable peer exchange, so it must NOT
    // fall through to the HTTPS anchor (which would needlessly re-upload our request + push_pack).
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(initiatorDb, { blockCid, state: 'integrity_verified', size: bytes.length }, [
      bytes,
    ]);
    await putPublicRecordWithBlock(initiatorDb, blockCid); // the initiator can serve it
    await quarantineMissing(responderDb, [blockCid]); // only the RESPONDER is missing it

    const link = new FakeLink();
    const relay = makeRelayFetch();
    const anchorUrls: string[] = [];
    const anchorFetch = (async (input: string | URL | Request) => {
      anchorUrls.push(String(input));
      return new Response(new Uint8Array([0]) as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;
    const p2p = await import('@licio/lcap-p2p');
    const signalKey = await p2p.importSignalKey(
      await (await import('./signal-key.js')).derivePublicSignalKeyBytes(ROOM),
    );
    const { createSignalClient } = await import('./p2p-signaling.js');
    const respSignals = createSignalClient({ apiBase: 'http://relay.test', fetchFn: relay });

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
        httpsConfig: { fetchFn: anchorFetch },
        rtcFactory: () => new FakePeer(link, 'initiator'),
        pollIntervalMs: 1,
        timeoutMs: 5000,
      }),
      responderDone,
    ]);

    expect(result?.transport).toBe('webrtc'); // served-only is still a successful P2P round
    expect(result?.ingested).toBeNull(); // we ingested nothing (no gaps)
    expect(anchorUrls.some((u) => u.includes('/exchange'))).toBe(false); // never hit the anchor
  });

  it('falls back to the anchor when WebRTC served the peer but left OUR wants unfilled (#BK)', async () => {
    // The initiator HOLDS a block the responder wants (so it SERVES the peer → served=true) but
    // ALSO has its OWN gap the responder LACKS (so it ingests nothing over WebRTC).  A served-only
    // round with UNFILLED local wants must NOT be reported as carried — it must back-stop at the
    // authoritative anchor, which DOES have our gap.  Without the fix this returned 'webrtc' and our
    // missing content stayed unfilled.
    const peerBytes = new Uint8Array([1, 2, 3, 4]);
    const peerBlockCid = await cidFor('block', peerBytes);
    await putBlock(
      initiatorDb,
      { blockCid: peerBlockCid, state: 'integrity_verified', size: peerBytes.length },
      [peerBytes],
    );
    await putPublicRecordWithBlock(initiatorDb, peerBlockCid); // the initiator can serve it
    await quarantineMissing(responderDb, [peerBlockCid]); // the RESPONDER wants it

    const gapBytes = new Uint8Array([7, 7, 7, 7, 7]);
    const gapCid = await cidFor('block', gapBytes);
    await quarantineMissing(initiatorDb, [gapCid]); // the INITIATOR wants this — the peer lacks it

    const anchorBody = await anchorResponseServing(new Map([[gapCid, gapBytes]]), [gapCid]);
    const anchorUrls: string[] = [];
    const anchorFetch = (async (input: string | URL | Request) => {
      anchorUrls.push(String(input));
      if (String(input).includes('/exchange'))
        return new Response(anchorBody as BodyInit, { status: 200 });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const link = new FakeLink();
    const relay = makeRelayFetch();
    const p2p = await import('@licio/lcap-p2p');
    const signalKey = await p2p.importSignalKey(
      await (await import('./signal-key.js')).derivePublicSignalKeyBytes(ROOM),
    );
    const { createSignalClient } = await import('./p2p-signaling.js');
    const respSignals = createSignalClient({ apiBase: 'http://relay.test', fetchFn: relay });

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
        httpsConfig: { fetchFn: anchorFetch },
        rtcFactory: () => new FakePeer(link, 'initiator'),
        pollIntervalMs: 1,
        timeoutMs: 5000,
      }),
      responderDone,
    ]);

    expect(result?.transport).toBe('https'); // served-only WITH unfilled wants ⇒ back-stop at anchor
    expect(anchorUrls.some((u) => u.includes('/exchange'))).toBe(true); // the anchor WAS reached
    expect(result?.ingested?.blocks).toBe(1); // our gap filled from the authoritative anchor
    expect(await readBlockBytes(initiatorDb, gapCid)).toEqual(gapBytes);
  });

  it('a served-only round does NOT re-hit the anchor when our advertised want is already HELD (#1)', async () => {
    // A served-only WebRTC round (we served the peer; the peer had nothing for us) where our advertised
    // want is ALREADY HELD — modelling the peer's push filling it mid-round (quarantine rows are not
    // promoted on ingest, so the row lingers and the request still advertises it).  The post-round
    // recheck must see the want as FILLED and NOT needlessly back-stop at the anchor (re-uploading the
    // request + push).  Pre-fix, the stale pre-round snapshot fell through to the anchor.
    const peerBytes = new Uint8Array([2, 2, 2, 2]);
    const peerBlockCid = await cidFor('block', peerBytes);
    await putBlock(
      initiatorDb,
      { blockCid: peerBlockCid, state: 'integrity_verified', size: peerBytes.length },
      [peerBytes],
    );
    await putPublicRecordWithBlock(initiatorDb, peerBlockCid); // the initiator can serve the peer
    await quarantineMissing(responderDb, [peerBlockCid]); // the RESPONDER wants it

    // Our own advertised want is ALREADY HELD (the block is in the store; the quarantine row lingers).
    const heldBytes = new Uint8Array([5, 5, 5]);
    const heldCid = await cidFor('block', heldBytes);
    await putBlock(
      initiatorDb,
      { blockCid: heldCid, state: 'integrity_verified', size: heldBytes.length },
      [heldBytes],
    );
    await quarantineMissing(initiatorDb, [heldCid]); // stale row → the request still advertises it

    const anchorUrls: string[] = [];
    const anchorFetch = (async (input: string | URL | Request) => {
      anchorUrls.push(String(input));
      return new Response(new Uint8Array([0]) as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    const link = new FakeLink();
    const relay = makeRelayFetch();
    const p2p = await import('@licio/lcap-p2p');
    const signalKey = await p2p.importSignalKey(
      await (await import('./signal-key.js')).derivePublicSignalKeyBytes(ROOM),
    );
    const { createSignalClient } = await import('./p2p-signaling.js');
    const respSignals = createSignalClient({ apiBase: 'http://relay.test', fetchFn: relay });

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
        httpsConfig: { fetchFn: anchorFetch },
        rtcFactory: () => new FakePeer(link, 'initiator'),
        pollIntervalMs: 1,
        timeoutMs: 5000,
      }),
      responderDone,
    ]);

    expect(result?.transport).toBe('webrtc'); // the want is HELD ⇒ no remaining gap ⇒ anchor suppressed
    expect(anchorUrls.some((u) => u.includes('/exchange'))).toBe(false); // anchor never reached (#1)
  });

  it('a PARTIAL WebRTC ingest still backs off to the anchor for the remaining wants (#2)', async () => {
    // We advertise TWO wants; the peer serves only ONE (out.ingested !== null).  The OTHER want is
    // still absent, so the round must NOT be reported as carried — it must back-stop at the anchor,
    // which fills the remaining gap.  (Pre-fix, any non-null ingest suppressed the anchor.)
    const aBytes = new Uint8Array([1, 1, 1, 1]);
    const aCid = await cidFor('block', aBytes);
    const bBytes = new Uint8Array([2, 2, 2, 2]);
    const bCid = await cidFor('block', bBytes);
    // The RESPONDER holds + can serve only `a` (reachable from a public record); it lacks `b`.
    await putBlock(
      responderDb,
      { blockCid: aCid, state: 'integrity_verified', size: aBytes.length },
      [aBytes],
    );
    await putPublicRecordWithBlock(responderDb, aCid);
    // The INITIATOR wants BOTH.
    await quarantineMissing(initiatorDb, [aCid, bCid]);
    // The anchor serves the remaining gap `b`.
    const anchorBody = await anchorResponseServing(new Map([[bCid, bBytes]]), [bCid]);
    const anchorUrls: string[] = [];
    const anchorFetch = (async (input: string | URL | Request) => {
      anchorUrls.push(String(input));
      if (String(input).includes('/exchange'))
        return new Response(anchorBody as BodyInit, { status: 200 });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const link = new FakeLink();
    const relay = makeRelayFetch();
    const p2p = await import('@licio/lcap-p2p');
    const signalKey = await p2p.importSignalKey(
      await (await import('./signal-key.js')).derivePublicSignalKeyBytes(ROOM),
    );
    const { createSignalClient } = await import('./p2p-signaling.js');
    const respSignals = createSignalClient({ apiBase: 'http://relay.test', fetchFn: relay });

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
        httpsConfig: { fetchFn: anchorFetch },
        rtcFactory: () => new FakePeer(link, 'initiator'),
        pollIntervalMs: 1,
        timeoutMs: 5000,
      }),
      responderDone,
    ]);

    expect(result?.transport).toBe('https'); // a remaining want ⇒ back-stop at the anchor (#2)
    expect(anchorUrls.some((u) => u.includes('/exchange'))).toBe(true);
    expect(await readBlockBytes(initiatorDb, aCid)).toEqual(aBytes); // `a` filled by the WebRTC peer
    expect(await readBlockBytes(initiatorDb, bCid)).toEqual(bBytes); // `b` filled by the anchor
  });

  it('reports PARTIAL WebRTC progress when the anchor back-stop cannot complete (#3)', async () => {
    // WebRTC ingests `a` but not `b`; the anchor is OFFLINE.  The function must NOT return null (which
    // means EVERY path failed) — it made real progress over WebRTC.  It reports { transport: 'webrtc' }.
    const aBytes = new Uint8Array([3, 3, 3, 3]);
    const aCid = await cidFor('block', aBytes);
    const bCid = await cidFor('block', new Uint8Array([4, 4, 4, 4])); // wanted; nobody serves it
    await putBlock(
      responderDb,
      { blockCid: aCid, state: 'integrity_verified', size: aBytes.length },
      [aBytes],
    );
    await putPublicRecordWithBlock(responderDb, aCid); // the responder serves `a`
    await quarantineMissing(initiatorDb, [aCid, bCid]); // the initiator wants BOTH
    // The HTTPS anchor is OFFLINE (every request fails) → offlineExchange yields null.
    const anchorFetch = (async () =>
      new Response(null, { status: 503 })) as unknown as typeof fetch;

    const link = new FakeLink();
    const relay = makeRelayFetch();
    const p2p = await import('@licio/lcap-p2p');
    const signalKey = await p2p.importSignalKey(
      await (await import('./signal-key.js')).derivePublicSignalKeyBytes(ROOM),
    );
    const { createSignalClient } = await import('./p2p-signaling.js');
    const respSignals = createSignalClient({ apiBase: 'http://relay.test', fetchFn: relay });

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
        httpsConfig: { fetchFn: anchorFetch },
        rtcFactory: () => new FakePeer(link, 'initiator'),
        pollIntervalMs: 1,
        timeoutMs: 5000,
      }),
      responderDone,
    ]);

    expect(result).not.toBeNull(); // NOT a false failure — WebRTC made real progress (#3)
    expect(result?.transport).toBe('webrtc');
    expect(result?.ingested?.blocks).toBe(1); // `a` committed over WebRTC
    expect(await readBlockBytes(initiatorDb, aCid)).toEqual(aBytes);
    expect(await readBlockBytes(initiatorDb, bCid)).toBeUndefined(); // `b` unfilled (anchor offline)
  });

  it('threads the abort predicate into the anchor ingest, suppressing a post-cancel commit (#BJ)', async () => {
    // The HTTPS anchor does not thread the AbortSignal into fetch, so the anchor request can COMPLETE
    // after a Cancel/unmount fires mid-flight.  The pre-commit check at the boundary is not enough: a
    // cancel landing DURING readBundleForImport / importBundleObjects must still suppress the store
    // write.  The fix passes a live `() => !params.signal?.aborted` predicate to
    // ingestClientExchangeResponse, which re-checks it at the LEAF (right before the writes).
    const bytes = new Uint8Array([3, 1, 4, 1, 5, 9]);
    const blockCid = await cidFor('block', bytes);
    await quarantineMissing(initiatorDb, [blockCid]);
    const anchorBody = await anchorResponseServing(new Map([[blockCid, bytes]]), [blockCid]);

    // A controllable signal: NOT aborted until the anchor has responded, then the FIRST read (the
    // sync's pre-commit check at line ~174) still sees false (so we DON'T bail early via that check),
    // and EVERY later read — the abort predicate at the ingest boundary AND the commit leaf — sees
    // true.  fallbackExchange/HttpsTransport never read `.aborted`, so the first read after the fetch
    // is guaranteed to be that pre-commit check (no brittle read-counting).
    let anchorFetched = false;
    let preCommitConsumed = false;
    const signal = {
      get aborted(): boolean {
        if (!anchorFetched) return false; // all pre-anchor checks: not yet cancelled
        if (!preCommitConsumed) {
          preCommitConsumed = true;
          return false; // the sync's post-fetch pre-commit check proceeds into the ingest
        }
        return true; // the cancel is now observed by the ingest predicate (boundary + leaf)
      },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
      onabort: null,
      reason: undefined,
      throwIfAborted() {},
    } as unknown as AbortSignal;

    const httpsFetch = (async (input: string | URL | Request) => {
      anchorFetched = true;
      if (String(input).includes('/exchange'))
        return new Response(anchorBody as BodyInit, { status: 200 });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const result = await syncRoomOverP2p({
      db: initiatorDb,
      roomIdHash: ROOM,
      selfPeerKey: 'alice',
      remotePeerKey: 'bob',
      initiator: true,
      privacy: { mode: 'standard', userEnabled: false }, // off → straight to the anchor
      httpsConfig: { fetchFn: httpsFetch },
      rtcFactory: () => new FakePeer(new FakeLink(), 'initiator'),
      signal,
      timeoutMs: 50,
    });
    // The anchor exchange ran (transport reported), but the ingest's leaf predicate suppressed the
    // commit — nothing landed in IndexedDB after the cancel.  Without the fix the block IS written.
    expect(result?.transport).toBe('https');
    expect(result?.ingested).toBeNull(); // the leaf predicate suppressed the commit (#BJ)
    expect(await readBlockBytes(initiatorDb, blockCid)).toBeUndefined(); // nothing written post-cancel
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

  it('fails CLOSED to the anchor when NEITHER privacy nor decision is supplied (PUB-WEBRTC-DEFAULT-OFF)', async () => {
    // §26.4 WebRTC is off by default: a caller that omits BOTH `privacy` and `decision` must NOT
    // get an IP-revealing peer connection synthesized for it — the decision defaults to blocked, so
    // the exchange rides the HTTPS anchor.  (Regression: the synthesized fallback used to default
    // `userEnabled: true`, silently opening WebRTC with no consent.)
    const bytes = new Uint8Array([2, 7, 1, 8, 2, 8]);
    const blockCid = await cidFor('block', bytes);
    await quarantineMissing(initiatorDb, [blockCid]);
    const anchorBody = await anchorResponseServing(new Map([[blockCid, bytes]]), [blockCid]);
    let rtcFactoryCalled = false;

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
      // NEITHER privacy NOR decision — the fail-closed default must block WebRTC.
      httpsConfig: { fetchFn: httpsFetch },
      rtcFactory: () => {
        rtcFactoryCalled = true;
        return new FakePeer(new FakeLink(), 'initiator');
      },
      timeoutMs: 50,
    });
    expect(rtcFactoryCalled).toBe(false); // no RTCPeerConnection ever constructed
    expect(result?.transport).toBe('https');
    expect(result?.ingested?.blocks).toBe(1);
    expect(await readBlockBytes(initiatorDb, blockCid)).toEqual(bytes);
  });

  it('does NOT upload to the HTTPS anchor after the sync is CANCELLED (#6)', async () => {
    const controller = new AbortController();
    controller.abort(); // the user cancelled before/while the WebRTC leg failed
    const urls: string[] = [];
    const httpsFetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(new Uint8Array([0]) as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await syncRoomOverP2p({
      db: initiatorDb,
      roomIdHash: ROOM,
      selfPeerKey: 'alice',
      remotePeerKey: 'bob',
      initiator: true,
      privacy: { mode: 'standard', userEnabled: false },
      httpsConfig: { fetchFn: httpsFetch },
      rtcFactory: () => new FakePeer(new FakeLink(), 'initiator'),
      signal: controller.signal,
      timeoutMs: 50,
    });
    expect(result).toBeNull();
    // The cancelled sync uploaded NOTHING to the server (the anchor fetch was never reached).
    expect(urls.some((u) => u.includes('/exchange'))).toBe(false);
  });

  it('does NOT start WebRTC signaling when the signal is already aborted (#V)', async () => {
    // Cancel / unmount can fire WHILE buildClientExchangeRequest + the signal-key derivation await;
    // execution must NOT reach the WebRTC connect (which would POST a sealed offer) with an
    // already-aborted signal.
    const controller = new AbortController();
    controller.abort();
    let rtcCreated = false;
    const result = await syncRoomOverP2p({
      db: initiatorDb,
      roomIdHash: ROOM,
      selfPeerKey: 'alice',
      remotePeerKey: 'bob',
      initiator: true,
      privacy: { mode: 'standard', userEnabled: true }, // WebRTC ENABLED — only the abort stops it
      rtcFactory: () => {
        rtcCreated = true;
        return new FakePeer(new FakeLink(), 'initiator');
      },
      signal: controller.signal,
      timeoutMs: 50,
    });
    expect(result).toBeNull();
    expect(rtcCreated).toBe(false); // WebRTC signaling never started for an already-cancelled sync
  });
});
