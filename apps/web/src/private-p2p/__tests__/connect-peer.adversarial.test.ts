// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PRIV-CARRIER-7 — a DETERMINISTIC adversarial-peer harness for the carrier's engineered DoS /
// handshake-error bounds.  The faithful fake-pair (`connect-peer.test.ts`) drives TWO honest
// `connectPrivatePeer` peers and completes the §15.5 handshake in a handful of microtasks — too fast
// to inject a malformed hello / a mid-handshake close / an ICE flood at a controlled moment.  So this
// suite drives ONE honest peer (the SUT, "alice") through `connectPrivatePeer` and replaces its
// `RTCPeerConnection` with a fully CONTROLLABLE fake: the test opens alice's data channel, injects
// handshake frames, floods ICE, and closes the channel at EXACTLY the moment under test.  No timing
// race — every step is explicitly sequenced.
//
// alice is forced to be the OFFERER (so she `createDataChannel`s the channel the test controls) by
// choosing an adversary device id whose blind id sorts AFTER alice's (the carrier's role tiebreak).
import { describe, expect, it } from 'vitest';
import {
  type ConnectPrivatePeerParams,
  connectPrivatePeer,
  pickDialCandidate,
  type RtcDataChannelLike,
  type RtcIceCandidateInit,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionInit,
  selectFreshestCandidates,
} from '../connect-peer.js';
import type { PresenceRecord, RendezvousTransport, WireSignal } from '../rendezvous-client.js';

const PROFILE = { name: 'Adversarial Carrier Test', room_type: 'global_topic' } as const;

// --- a server-blind in-memory rendezvous (FIFO signal queue per recipient) ----------
function inMemoryRendezvous(): RendezvousTransport & {
  readonly presence: PresenceRecord[];
  enqueueSignal(s: WireSignal): void;
} {
  const presence: PresenceRecord[] = [];
  const signalbox = new Map<string, WireSignal[]>();
  return {
    presence,
    async announce(record) {
      presence.push(record);
    },
    async poll(roomBlindId) {
      return presence.filter((r) => r.room_blind_id === roomBlindId);
    },
    async signal(signal) {
      const box = signalbox.get(signal.recipient_blind_id) ?? [];
      box.push(signal);
      signalbox.set(signal.recipient_blind_id, box);
    },
    async signalPoll(peerBlindId) {
      const box = signalbox.get(peerBlindId) ?? [];
      signalbox.set(peerBlindId, []);
      return box;
    },
    // The test injects sealed signals destined for alice (her blind id is the key).
    enqueueSignal(s: WireSignal) {
      const box = signalbox.get(s.recipient_blind_id) ?? [];
      box.push(s);
      signalbox.set(s.recipient_blind_id, box);
    },
  };
}

// --- alice's fully CONTROLLABLE data channel + peer connection ----------------------
class ControllableChannel implements RtcDataChannelLike {
  binaryType = 'blob';
  readyState = 'connecting';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data.slice(0))
          : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    );
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    queueMicrotask(() => this.onclose?.());
  }
  // --- explicit test controls ---
  fireOpen(): void {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    queueMicrotask(() => this.onopen?.());
  }
  deliver(data: string | ArrayBuffer): void {
    queueMicrotask(() => this.onmessage?.({ data }));
  }
}

class ControllablePeer implements RtcPeerConnectionLike {
  onicecandidate: ((event: { candidate: RtcIceCandidateInit | null }) => void) | null = null;
  ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null = null;
  readonly channel = new ControllableChannel();
  readonly iceApplied: RtcIceCandidateInit[] = [];
  createDataChannel(): RtcDataChannelLike {
    return this.channel; // offerer path — the channel the test controls
  }
  async createOffer(): Promise<RtcSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\nadv-offer' };
  }
  async createAnswer(): Promise<RtcSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0\r\nadv-answer' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(candidate: RtcIceCandidateInit): Promise<void> {
    this.iceApplied.push(candidate);
  }
  close(): void {}
}

/** The per-test wall-clock budget — generous so heavy CI / concurrent suites never flake it. */
const TEST_TIMEOUT_MS = 20_000;

/** Poll until `cond()` is true, flushing micro/macro tasks each loop, for up to `budgetMs` of
 *  WALL-CLOCK (not a fixed iteration count, which collapses under load) — robust to a busy CI. */
async function waitUntil(cond: () => boolean, label: string, budgetMs = 12_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

/** The crypto context the adversary needs to seal signals alice will open (PRIV-CARRIER-7 ICE flood). */
interface AdversaryCtx {
  readonly p2p: typeof import('@licio/private-p2p');
  readonly rendezvousKey: Uint8Array;
  readonly epoch: number;
  readonly timeBucket: number;
  readonly roomBlindId: string;
  readonly roomIdCommitment: Uint8Array;
  readonly aliceBlind: string;
  readonly adversaryBlind: string;
  readonly advEphemeral: { privateKey: CryptoKey; publicKey: Uint8Array };
  /** The adversary's REGISTERED device signing keypair (resolveDevice returns its public key), so it
   *  can complete a VALID §15.5 handshake for the opStash-flood case. */
  readonly advSigning: { privateKey: CryptoKey; publicKey: CryptoKey };
  readonly adversaryDeviceId: string;
}

interface Harness {
  readonly base: Omit<ConnectPrivatePeerParams, 'rtcFactory'>;
  /** The captured `ControllablePeer` (set once alice's rtcFactory runs). */
  peer(): ControllablePeer | undefined;
  makeRtcFactory(): () => ControllablePeer;
  readonly rendezvous: ReturnType<typeof inMemoryRendezvous>;
  readonly ctx: AdversaryCtx;
}

type P2P = typeof import('@licio/private-p2p');

/**
 * Draw rooms until alice's blind id admits an adversary device id that sorts AFTER it ⇒ alice is the
 * OFFERER (the carrier's role tiebreak is the bytewise-smaller blind id).  Blind ids are random HMACs,
 * so for a given room MOST candidates sort after alice — but when alice's OWN blind id draws high,
 * every candidate can fall below it.  Searching many candidates AND redrawing the room (a fresh
 * rendezvousKey ⇒ a fresh alice blind id) makes the role assignment DETERMINISTIC: combined failure
 * ≈ (1/257)^25 ≈ 0, so the harness never flakes on the draw.
 */
async function pickOffererRoom(p2p: P2P): Promise<{
  created: Awaited<ReturnType<P2P['createPrivateRoom']>>;
  epoch: number;
  rendezvousKey: Uint8Array;
  timeBucket: number;
  aliceBlind: string;
  adversaryDeviceId: string;
}> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const created = await p2p.createPrivateRoom({
      roomId: `room-adv-${attempt}-${Date.now().toString(36)}`,
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const epoch = Number(created.epochState.epoch);
    const rendezvousKey = created.epochState.keys.rendezvousKey;
    const timeBucket = p2p.rendezvousTimeBucket(Date.now());
    const aliceBlind = await p2p.derivePeerBlindId(rendezvousKey, 'founder-dev', epoch, timeBucket);
    for (let i = 0; i < 256; i++) {
      const candidate = `adversary-${i}`;
      const blind = await p2p.derivePeerBlindId(rendezvousKey, candidate, epoch, timeBucket);
      if (blind > aliceBlind) {
        return {
          created,
          epoch,
          rendezvousKey,
          timeBucket,
          aliceBlind,
          adversaryDeviceId: candidate,
        };
      }
    }
  }
  throw new Error('could not force the offerer role in 25 room draws (astronomically unlikely)');
}

/**
 * Build a harness where alice (the SUT) is FORCED to be the offerer (so she `createDataChannel`s the
 * channel the test controls), announce a real X25519 adversary signaling key, and return the connect
 * params bound to a captured `ControllablePeer` plus the crypto context for sealing signals.
 */
async function setupOffererHarness(): Promise<Harness> {
  const p2p = await import('@licio/private-p2p');
  const { created, epoch, rendezvousKey, timeBucket, aliceBlind, adversaryDeviceId } =
    await pickOffererRoom(p2p);

  const advEphemeral = await p2p.generateX25519KeyPair();
  const advSigning = await p2p.generateDeviceSigningKeyPair();
  const advSigningPub = p2p.toBase64Url(await p2p.exportPublicKeyRaw(advSigning.publicKey));
  const adversaryBlind = await p2p.derivePeerBlindId(
    rendezvousKey,
    adversaryDeviceId,
    epoch,
    timeBucket,
  );
  const roomBlindId = await p2p.deriveRoomBlindId(rendezvousKey, epoch, timeBucket);
  const rendezvous = inMemoryRendezvous();
  await rendezvous.announce(
    await p2p.buildRendezvousRecord({
      rendezvousKey,
      epoch,
      timeBucket,
      deviceId: adversaryDeviceId,
      announcement: {
        schema: 'licio.private.rendezvous_announcement.v1',
        peer_device_id: adversaryDeviceId,
        signaling_public_key: p2p.toBase64Url(advEphemeral.publicKey),
        transport_hints: [],
      },
      nowMs: Date.now(),
    }),
  );

  const base = {
    p2p,
    rendezvous,
    roomIdCommitment: created.roomIdCommitment,
    epoch,
    rendezvousKey,
    selfDeviceId: 'founder-dev',
    selfSigningKey: created.founder.signingKeyPair.privateKey,
    resolveDevice: (id: string) =>
      id === adversaryDeviceId
        ? { signingPublicKey: advSigningPub, activeAtEpoch: true }
        : undefined,
    transportMode: 'direct_allowed' as const,
    nowMs: () => Date.now(),
    // PRIV-CARRIER-3-POLL: a connect now KEEPS POLLING until the deadline (a fresh peer may appear /
    // a cooldown may expire), so a sole-failing-peer dial surfaces its typed error AT the deadline.
    // Keep that deadline short + poll less tightly so the handshake-error tests stay fast (the
    // handshake-COMPLETING tests resolve well under it, unaffected).
    pollIntervalMs: 10,
    timeoutMs: 1_000,
  } satisfies Omit<ConnectPrivatePeerParams, 'rtcFactory'>;

  let captured: ControllablePeer | undefined;
  return {
    base,
    peer: () => captured,
    makeRtcFactory: () => () => {
      captured = new ControllablePeer();
      return captured;
    },
    rendezvous,
    ctx: {
      p2p,
      rendezvousKey,
      epoch,
      timeBucket,
      roomBlindId,
      roomIdCommitment: created.roomIdCommitment,
      aliceBlind,
      adversaryBlind,
      advEphemeral,
      advSigning,
      adversaryDeviceId,
    },
  };
}

/** Derive the SAME pairwise signaling channel key alice derives, from her announced ephemeral key —
 *  so the adversary can seal §15.4 signals alice will open (the ECDH + the SHARED transcript match). */
async function deriveAliceChannelKey(
  ctx: AdversaryCtx,
  aliceEphPub: Uint8Array,
): Promise<Uint8Array> {
  return ctx.p2p.deriveChannelKey(
    ctx.advEphemeral.privateKey,
    aliceEphPub,
    {
      protocolVersion: 1, // SIGNALING_TRANSCRIPT_VERSION (the carrier pins it; decoupled from the wire version)
      roomIdCommitment: ctx.roomIdCommitment,
      epoch: ctx.epoch,
      ephemeralPublicKeyA: aliceEphPub, // A = alice (self, from alice's perspective) — the SHARED order
      ephemeralPublicKeyB: ctx.advEphemeral.publicKey, // B = the adversary (alice's peer)
    },
    ctx.p2p.CHANNEL_LABEL_SIGNALING,
  );
}

describe('connectPrivatePeer — deterministic adversarial DoS / handshake bounds (PRIV-CARRIER-7)', () => {
  it(
    'rejects a hello that passes truthiness but FAILS the schema → handshake_malformed_hello (fast)',
    async () => {
      const h = await setupOffererHarness();
      const started = Date.now();
      const connectP = connectPrivatePeer({ ...h.base, rtcFactory: h.makeRtcFactory() });

      // Alice discovered the adversary and armed her offerer channel; open it ⇒ the handshake starts.
      await waitUntil(() => h.peer()?.channel.onmessage != null, 'channel armed');
      const channel = h.peer()?.channel;
      if (!channel) throw new Error('no channel');
      channel.fireOpen();

      // The peer answers with a hello that is a truthy object but is NOT a valid handshake hello.
      channel.deliver(JSON.stringify({ t: 'hello', hello: { author_device_id: 'x', junk: true } }));

      await expect(connectP).rejects.toMatchObject({ reason: 'handshake_malformed_hello' });
      // The TYPED handshake error is surfaced — NOT masked into a generic `timeout`.  A malformed
      // hello is detected immediately; the connect then keeps polling to its (short) deadline for a
      // fresh peer (PRIV-CARRIER-3-POLL) and raises THAT captured dial failure.  Bounded by the
      // deadline, never the multi-second default.
      expect(Date.now() - started).toBeLessThan(2_500);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects when the data channel CLOSES mid-handshake → handshake_channel_closed',
    async () => {
      const h = await setupOffererHarness();
      const connectP = connectPrivatePeer({ ...h.base, rtcFactory: h.makeRtcFactory() });

      await waitUntil(() => h.peer()?.channel.onmessage != null, 'channel armed');
      const channel = h.peer()?.channel;
      if (!channel) throw new Error('no channel');
      channel.fireOpen();
      // Wait for the handshake to wire its onclose (runHandshake), THEN close before any proof.
      await waitUntil(() => channel.onclose != null, 'handshake onclose wired');
      channel.close();

      await expect(connectP).rejects.toMatchObject({ reason: 'handshake_channel_closed' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'caps the pre-remoteDescription ICE buffer at MAX_PENDING_ICE = 64 (PRIV-CARRIER-7)',
    async () => {
      const h = await setupOffererHarness();
      const { ctx } = h;
      const ac = new AbortController();
      // Swallow the eventual abort rejection — we observe the cap before tearing the connect down.
      const connectP = connectPrivatePeer({
        ...h.base,
        rtcFactory: h.makeRtcFactory(),
        signal: ac.signal,
      }).catch(() => undefined);

      // Alice announces her ephemeral signaling key during connect; open it to derive the shared key.
      await waitUntil(() => h.rendezvous.presence.length >= 2, 'alice announced');
      const aliceRecord = h.rendezvous.presence.find((r) => r.peer_blind_id === ctx.aliceBlind);
      if (!aliceRecord) throw new Error('alice record not found');
      const aliceAnn = await ctx.p2p.openRendezvousAnnouncement(aliceRecord, ctx.rendezvousKey);
      const aliceEphPub = ctx.p2p.fromBase64Url(aliceAnn.signaling_public_key);
      const channelKey = await deriveAliceChannelKey(ctx, aliceEphPub);

      // The carrier drains a PAIRWISE, DIRECTED §15.4 queue — keyed on BOTH the sender's and the
      // recipient's signalling identity — so a device's concurrent sessions never steal each other's
      // deliver-once signals even though the device has one identity per bucket.  Address the flood
      // to alice's inbound queue FOR THIS SENDER (adversary → alice); the sender field is the
      // reverse direction (alice → adversary), which is where a reply would go.
      const routing = {
        roomBlindId: ctx.roomBlindId,
        senderBlindId: await ctx.p2p.deriveSignalAddress(
          ctx.rendezvousKey,
          aliceEphPub,
          ctx.advEphemeral.publicKey,
          ctx.epoch,
          ctx.timeBucket,
        ),
        recipientBlindId: await ctx.p2p.deriveSignalAddress(
          ctx.rendezvousKey,
          ctx.advEphemeral.publicKey,
          aliceEphPub,
          ctx.epoch,
          ctx.timeBucket,
        ),
        expiresAt: Date.now() + 5 * 60_000,
      };

      // FLOOD: 100 trickled ICE candidates BEFORE the answer ⇒ all arrive while remoteDescription is
      // unset, so the carrier must buffer them (and cap the buffer).
      for (let i = 0; i < 100; i++) {
        h.rendezvous.enqueueSignal(
          await ctx.p2p.sealSignal(
            {
              schema: 'licio.private.signaling_payload.v1',
              kind: 'ice',
              ice_candidate: `candidate:${i} 1 udp 1 1.2.3.4 9 typ host`,
              sdp_mid: '0',
              sdp_mline_index: 0,
            },
            channelKey,
            routing,
          ),
        );
      }
      // The answer applies the remote description ⇒ flushes the (capped) buffer into addIceCandidate.
      h.rendezvous.enqueueSignal(
        await ctx.p2p.sealSignal(
          {
            schema: 'licio.private.signaling_payload.v1',
            kind: 'answer',
            sdp: 'v=0\r\nadv-answer',
          },
          channelKey,
          routing,
        ),
      );

      await waitUntil(
        () => (h.peer()?.iceApplied.length ?? 0) > 0,
        'answer flushed the ICE buffer',
      );
      await new Promise((r) => setTimeout(r, 20)); // let any further flush settle
      // EXACTLY 64 of the 100 flooded candidates were buffered + applied — 36 dropped past the cap.
      expect(h.peer()?.iceApplied.length).toBe(64);

      ac.abort();
      await connectP;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ACCEPTS a signal skewed within the server clock-skew window, not the tight 5s grace (PRIV-CARRIER-SKEW)',
    async () => {
      const h = await setupOffererHarness();
      const ctx = h.ctx;
      const ac = new AbortController();
      const connectP = connectPrivatePeer({
        ...h.base,
        rtcFactory: h.makeRtcFactory(),
        signal: ac.signal,
      }).catch(() => undefined);

      await waitUntil(() => h.rendezvous.presence.length >= 2, 'alice announced');
      const aliceRecord = h.rendezvous.presence.find((r) => r.peer_blind_id === ctx.aliceBlind);
      if (!aliceRecord) throw new Error('alice record not found');
      const aliceAnn = await ctx.p2p.openRendezvousAnnouncement(aliceRecord, ctx.rendezvousKey);
      const aliceEphPub = ctx.p2p.fromBase64Url(aliceAnn.signaling_public_key);
      const channelKey = await deriveAliceChannelKey(ctx, aliceEphPub);
      const routingBase = {
        roomBlindId: ctx.roomBlindId,
        senderBlindId: await ctx.p2p.deriveSignalAddress(
          ctx.rendezvousKey,
          aliceEphPub,
          ctx.advEphemeral.publicKey,
          ctx.epoch,
          ctx.timeBucket,
        ),
        recipientBlindId: await ctx.p2p.deriveSignalAddress(
          ctx.rendezvousKey,
          ctx.advEphemeral.publicKey,
          aliceEphPub,
          ctx.epoch,
          ctx.timeBucket,
        ),
      };
      // The answer (normal expiry ⇒ always accepted) applies the remote description so a following ICE
      // flushes into addIceCandidate.
      h.rendezvous.enqueueSignal(
        await ctx.p2p.sealSignal(
          {
            schema: 'licio.private.signaling_payload.v1',
            kind: 'answer',
            sdp: 'v=0\r\nadv-answer',
          },
          channelKey,
          { ...routingBase, expiresAt: Date.now() + 5 * 60_000 },
        ),
      );
      // An ICE candidate stamped 9 min ahead — BEYOND the tight 5 s grace but WITHIN the server's 5-min
      // clock-skew tolerance (ttl 5 min + a 4-min skew).  A clock-ahead mobile sender stamps exactly
      // this; the recipient MUST accept it (the server already stored it) rather than drop it as
      // far-future, or WebRTC setup silently fails for skewed devices.
      h.rendezvous.enqueueSignal(
        await ctx.p2p.sealSignal(
          {
            schema: 'licio.private.signaling_payload.v1',
            kind: 'ice',
            ice_candidate: 'candidate:0 1 udp 1 1.2.3.4 9 typ host',
            sdp_mid: '0',
            sdp_mline_index: 0,
          },
          channelKey,
          { ...routingBase, expiresAt: Date.now() + 9 * 60_000 },
        ),
      );

      await waitUntil(() => (h.peer()?.iceApplied.length ?? 0) > 0, 'skewed ICE applied');
      expect(h.peer()?.iceApplied.length).toBe(1); // the skewed candidate was accepted, not dropped

      ac.abort();
      await connectP;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'survives a >1 MiB pre-handshake binary flood (opStash bounded) and STILL completes (PRIV-CARRIER-7)',
    async () => {
      const h = await setupOffererHarness();
      const { ctx } = h;
      const connectP = connectPrivatePeer({ ...h.base, rtcFactory: h.makeRtcFactory() });
      await waitUntil(() => h.peer()?.channel.onmessage != null, 'channel armed');
      const channel = h.peer()?.channel;
      if (!channel) throw new Error('no channel');
      channel.fireOpen();

      // 1) Capture alice's hello (the first frame she sends on open).
      await waitUntil(() => channel.sent.length >= 1, 'alice sent hello');
      const aliceHello = (JSON.parse(channel.sent[0] as string) as { hello: unknown }).hello;

      // 2) Send the adversary's VALID hello (a real handshake ephemeral, the SAME proto version).
      const advHsEph = await ctx.p2p.generateX25519KeyPair();
      const hsCtx = {
        protocolVersion: ctx.p2p.HANDSHAKE_PROTOCOL_VERSION,
        roomIdCommitment: ctx.roomIdCommitment,
        epoch: ctx.epoch,
      };
      const advHello = ctx.p2p.buildHandshakeHello({
        deviceId: ctx.adversaryDeviceId,
        ephemeralPublicKey: advHsEph.publicKey,
        helloNonce: ctx.p2p.randomBytes(32),
        protocolVersion: ctx.p2p.HANDSHAKE_PROTOCOL_VERSION,
      });
      channel.deliver(JSON.stringify({ t: 'hello', hello: advHello }));

      // 3) FLOOD ~1.5 MiB of pre-handshake BINARY frames (a slowplaying peer streaming op frames): the
      //    carrier stashes them — but only up to the 1 MiB cap; the rest are dropped.
      const chunk = new Uint8Array(64 * 1024); // 64 KiB
      for (let i = 0; i < 24; i++) channel.deliver(chunk.buffer.slice(0)); // ~1.5 MiB

      // 4) Wait for alice's proof, then send the adversary's VALID proof ⇒ alice verifies + completes.
      await waitUntil(() => channel.sent.length >= 2, 'alice sent proof');
      const advProofSig = await ctx.p2p.signHandshakeProof(
        ctx.advSigning.privateKey,
        advHello,
        aliceHello as never,
        hsCtx,
      );
      channel.deliver(JSON.stringify({ t: 'proof', sig: ctx.p2p.toBase64Url(advProofSig) }));

      // The connection COMPLETES despite the flood (the opStash bound prevented unbounded growth).
      const result = await connectP;
      expect(result.peerDeviceId).toBe(ctx.adversaryDeviceId);

      // And the garbage flood frames NEVER reach the application: each stashed frame is re-opened under
      // the §15.5 session key and fails (it is not a valid sealed op frame), so it is dropped.
      let delivered = 0;
      result.channel.onMessage(() => {
        delivered += 1;
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(delivered).toBe(0);
      result.channel.close();
    },
    TEST_TIMEOUT_MS,
  );
});

// --- PRIV-CARRIER-FRESHEST-NOSPOOF: candidate dedup must not trust the claimed device id ----------
describe('selectFreshestCandidates (rendezvous candidate dedup)', () => {
  const cand = (ephemeral: string, deviceId: string, expiresAt: number) => ({
    record: { expires_at: expiresAt },
    ann: { signaling_public_key: ephemeral, peer_device_id: deviceId },
  });

  it('does NOT let a spoof claiming the honest peer’s device id evict the honest candidate', () => {
    // Honest device "bob" announces ephemeral E_h; a hostile member seals a SPOOF claiming the SAME
    // `peer_device_id` ("bob") with a DISTINCT ephemeral E_s and a LATER expires_at.  Deduping by the
    // claimed device id would drop the honest record (max-expires wins), leaving "bob" unreachable.
    const honest = cand('E_h', 'bob', 100);
    const spoof = cand('E_s', 'bob', 500); // later expiry, forged claim of bob's id
    const out = selectFreshestCandidates([honest, spoof]);
    // BOTH distinct ephemerals survive — the honest one is never dropped by the unproven claim.
    expect(out.map((c) => c.ann.signaling_public_key).sort()).toEqual(['E_h', 'E_s']);
    // Sorted freshest-first: the spoof (later expiry) is tried first (where the §15.5 mismatch check
    // rejects it), and the honest candidate is reached on a later round —
    // guaranteed within two by `pickDialCandidate`'s alternation, even while the
    // flooder keeps minting fresher records.
    expect(out[0]?.ann.signaling_public_key).toBe('E_s');
    expect(out[1]?.ann.signaling_public_key).toBe('E_h');
  });

  it('collapses a genuine re-announcement of the SAME ephemeral to the fresher record', () => {
    const stale = cand('E', 'bob', 100);
    const fresh = cand('E', 'bob', 400); // same dial re-announced with a longer TTL
    const out = selectFreshestCandidates([stale, fresh]);
    expect(out).toHaveLength(1);
    expect(out[0]?.record.expires_at).toBe(400); // kept the freshest, dropped the stale duplicate
  });

  it('keeps every distinct ephemeral and orders them freshest-first', () => {
    const out = selectFreshestCandidates([
      cand('E1', 'x', 200),
      cand('E2', 'y', 900),
      cand('E3', 'z', 500),
    ]);
    expect(out.map((c) => c.ann.signaling_public_key)).toEqual(['E2', 'E3', 'E1']);
  });
});

// --- Dial fairness: freshest-first alone is starvable -------------------------------------------
describe('pickDialCandidate (a rotating flooder cannot own every dial)', () => {
  it('alternates between the freshest and the most starved candidate', () => {
    const sample = ['freshest', 'middle', 'oldest'];
    expect(pickDialCandidate(sample, 0)).toBe('freshest');
    expect(pickDialCandidate(sample, 1)).toBe('oldest');
    expect(pickDialCandidate(sample, 2)).toBe('freshest');
    expect(pickDialCandidate(sample, 3)).toBe('oldest');
  });

  it('reaches an honest peer within TWO rounds however fast spoofs are minted', () => {
    // The cooldown is keyed by the record's ephemeral key, so a hostile member
    // that rotates it puts a NEW spoof at the head of every re-polled sample —
    // `triable[0]` would hand it every dial until the connect deadline expired
    // and the honest peer behind it would never be reached.
    const honest = 'E_honest';
    const dialled: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      // A fresh spoof each round, always ahead of the honest record.
      const sample = [`E_spoof_${round}`, honest];
      const pick = pickDialCandidate(sample, round);
      if (pick !== undefined) dialled.push(pick);
    }
    expect(dialled).toContain(honest);
    expect(dialled.indexOf(honest)).toBeLessThanOrEqual(1);
  });

  it('a single candidate is dialled on every round', () => {
    expect(pickDialCandidate(['only'], 0)).toBe('only');
    expect(pickDialCandidate(['only'], 1)).toBe('only');
    expect(pickDialCandidate([], 0)).toBeUndefined();
  });
});
