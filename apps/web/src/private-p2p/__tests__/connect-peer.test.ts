// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.3 (carrier) — `connectPrivatePeer` end-to-end through a faithful fake
// RTCPeerConnection PAIR + an in-memory server-blind rendezvous.  This exercises the
// REAL orchestration: blind-rendezvous discovery, the X25519-ECDH signaling channel,
// offer/answer/ICE over SEALED signals, the §15.5 membership handshake (real Ed25519
// proofs verified against injected device keys), and then a real op-exchange over the
// resulting `PeerChannel` driving two real engines to byte-identical convergence.

import { describe, expect, it } from 'vitest';
import {
  type ConnectPrivatePeerParams,
  connectPrivatePeer,
  type RtcDataChannelLike,
  type RtcIceCandidateInit,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionInit,
} from '../connect-peer.js';
import type { PresenceRecord, RendezvousTransport, WireSignal } from '../rendezvous-client.js';
import { type PeerChannel, PrivateSyncSession, type SyncCodec } from '../sync-session.js';

const PROFILE = { name: 'Carrier Test', room_type: 'global_topic' } as const;

// --- a faithful fake RTCPeerConnection pair (role-agnostic) -------------------------

class FakeChannel implements RtcDataChannelLike {
  binaryType = 'blob';
  readyState = 'connecting';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  peer: FakeChannel | null = null;
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    const peer = this.peer;
    if (peer?.readyState !== 'open') return;
    if (typeof data === 'string') {
      queueMicrotask(() => peer.onmessage?.({ data }));
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data.slice(0))
        : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    queueMicrotask(() => peer.onmessage?.({ data: bytes.buffer }));
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
  offererChannel: FakeChannel | null = null;
  answererChannel: FakeChannel | null = null;
  answerExchanged = false;
  maybeOpen(): void {
    if (this.offererChannel && this.answererChannel && this.answerExchanged) {
      this.offererChannel.peer = this.answererChannel;
      this.answererChannel.peer = this.offererChannel;
      this.offererChannel.open();
      this.answererChannel.open();
    }
  }
}

// WP-9 regression — every ICE candidate the carrier RECONSTRUCTS + feeds to a peer's
// addIceCandidate is captured here, so a test can assert the carrier preserved
// sdpMid/sdpMLineIndex (a real addIceCandidate rejects a candidate with neither).
const receivedIceCandidates: RtcIceCandidateInit[] = [];

class FakePeer implements RtcPeerConnectionLike {
  onicecandidate: ((event: { candidate: RtcIceCandidateInit | null }) => void) | null = null;
  ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null = null;
  constructor(private readonly link: FakeLink) {}
  createDataChannel(): RtcDataChannelLike {
    const ch = new FakeChannel();
    this.link.offererChannel = ch; // calling this ⇒ we are the offerer
    return ch;
  }
  async createOffer(): Promise<RtcSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\nfake-offer' };
  }
  async createAnswer(): Promise<RtcSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0\r\nfake-answer' };
  }
  async setLocalDescription(): Promise<void> {
    // A realistic candidate carries sdpMid + sdpMLineIndex (as a browser emits) so the
    // carrier must convey them; the WP-9 fix relays them and the answerer reconstructs them.
    queueMicrotask(() =>
      this.onicecandidate?.({
        candidate: {
          candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      }),
    );
    queueMicrotask(() => this.onicecandidate?.({ candidate: null }));
  }
  async setRemoteDescription(description: RtcSessionDescriptionInit): Promise<void> {
    if (description.type === 'offer') {
      const ch = new FakeChannel();
      this.link.answererChannel = ch; // receiving an offer ⇒ we are the answerer
      queueMicrotask(() => this.ondatachannel?.({ channel: ch }));
    } else if (description.type === 'answer') {
      this.link.answerExchanged = true;
      this.link.maybeOpen();
    }
  }
  async addIceCandidate(candidate: RtcIceCandidateInit): Promise<void> {
    // The fake opens on SDP exchange; here we CAPTURE the reconstructed candidate so a test
    // can assert the carrier preserved sdpMid/sdpMLineIndex through the wire.
    receivedIceCandidates.push(candidate);
  }
  close(): void {
    /* no-op */
  }
}

// --- an in-memory server-blind rendezvous (poll never an existence oracle) ----------

function inMemoryRendezvous(): RendezvousTransport {
  const presence: PresenceRecord[] = [];
  const signalbox = new Map<string, WireSignal[]>();
  return {
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
  };
}

async function settle(channels: { delivered: () => number }): Promise<void> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 2_000; i++) {
    const d = channels.delivered();
    if (d === last) {
      if (++stable >= 25) return;
    } else {
      stable = 0;
      last = d;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('WS-S.4.3 connectPrivatePeer (live carrier)', () => {
  it('discovers, signals, membership-handshakes, and converges two engines', async () => {
    const p2p = await import('@licio/private-p2p');
    const roomId = 'room-carrier';
    const created = await p2p.createPrivateRoom({
      roomId,
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const epoch = Number(created.epochState.epoch);
    const rendezvousKey = created.epochState.keys.rendezvousKey;
    const roomIdCommitment = created.roomIdCommitment;

    // Two device identities for the §15.5 handshake: the founder device (alice) + a
    // second registered device (bob).  resolveDevice is the injected seam.
    const devB = await p2p.generateDeviceSigningKeyPair();
    const devAPub = p2p.toBase64Url(
      await p2p.exportPublicKeyRaw(created.founder.signingKeyPair.publicKey),
    );
    const devBPub = p2p.toBase64Url(await p2p.exportPublicKeyRaw(devB.publicKey));
    const resolve = (
      id: string,
    ): { signingPublicKey: string; activeAtEpoch: boolean } | undefined => {
      if (id === 'founder-dev') return { signingPublicKey: devAPub, activeAtEpoch: true };
      if (id === 'device-b') return { signingPublicKey: devBPub, activeAtEpoch: true };
      return undefined;
    };

    // Two engines over the SAME room keys; alice authors content, bob is fresh.
    const alice = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new p2p.InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(created.genesisOp, created.sealParams);
    const story = await p2p.buildRoomOp(
      {
        roomId,
        roomIdCommitment,
        epochState: created.epochState,
        author: {
          memberId: 'founder',
          deviceId: 'founder-dev',
          signingKey: created.founder.signingKeyPair.privateKey,
          seq: alice.nextAuthorSeq('founder-dev'),
        },
        opId: globalThis.crypto.randomUUID(),
        parents: alice.heads(),
        lamport: alice.nextLamport(),
      },
      {
        type: 'story.create',
        story_id: 'carried-story',
        thread_id: 't1',
        title: 'ferried over WebRTC',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
    );
    await alice.applyLocalOp(story.op, story.sealParams);

    const bob = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new p2p.InMemoryPrivateRoomStorage(),
    });

    const rendezvous = inMemoryRendezvous();
    const link = new FakeLink();
    const base = {
      p2p,
      rendezvous,
      roomIdCommitment,
      epoch,
      rendezvousKey,
      transportMode: 'direct_allowed' as const,
      nowMs: () => Date.now(),
      pollIntervalMs: 1,
      timeoutMs: 3_000,
      rtcFactory: () => new FakePeer(link),
    } satisfies Partial<ConnectPrivatePeerParams>;

    const [{ channel: chAlice, peerDeviceId: alicePeer }, { channel: chBob }] = await Promise.all([
      connectPrivatePeer({
        ...base,
        selfDeviceId: 'founder-dev',
        selfSigningKey: created.founder.signingKeyPair.privateKey,
        resolveDevice: resolve,
      }),
      connectPrivatePeer({
        ...base,
        selfDeviceId: 'device-b',
        selfSigningKey: devB.privateKey,
        resolveDevice: resolve,
      }),
    ]);
    // The handshake surfaces the verified peer device id (the mesh keys connected peers by it).
    expect(alicePeer).toBe('device-b');

    // The handshake passed on both sides ⇒ live PeerChannels.  Now drive the op-exchange.
    const codec: SyncCodec = {
      encodeSyncMessage: p2p.encodeSyncMessage,
      decodeSyncMessage: p2p.decodeSyncMessage,
    };
    let aDelivered = 0;
    let bDelivered = 0;
    const count = (ch: PeerChannel, bump: () => void): PeerChannel => ({
      send: (f) => {
        bump();
        ch.send(f);
      },
      onMessage: (l) => ch.onMessage(l),
      onClose: (l) => ch.onClose?.(l),
      close: () => ch.close(),
    });
    const errors: unknown[] = [];
    const onError = (e: unknown): void => {
      errors.push(e);
    };
    const sa = new PrivateSyncSession(
      alice,
      count(chAlice, () => aDelivered++),
      codec,
      { onError },
    );
    const sb = new PrivateSyncSession(
      bob,
      count(chBob, () => bDelivered++),
      codec,
      { onError },
    );
    sa.start();
    sb.start();
    await settle({ delivered: () => aDelivered + bDelivered });

    expect(errors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);
    expect(bob.state().stories.get('carried-story')?.title).toBe('ferried over WebRTC');
    expect(Array.from(p2p.roomStateCommitment(bob.state()))).toEqual(
      Array.from(p2p.roomStateCommitment(alice.state())),
    );
    // WP-9 regression: the carrier conveyed sdpMid/sdpMLineIndex with each ICE candidate
    // (a real addIceCandidate rejects a candidate with neither — the fake-RTC path used to
    // mask this).  At least one reconstructed candidate must carry the m-line identity.
    expect(receivedIceCandidates.length).toBeGreaterThan(0);
    expect(receivedIceCandidates.some((c) => c.sdpMid != null || c.sdpMLineIndex != null)).toBe(
      true,
    );
    sa.close();
    sb.close();
  });

  it('FAILS CLOSED when the peer device is not registered (handshake rejects)', async () => {
    const p2p = await import('@licio/private-p2p');
    const created = await p2p.createPrivateRoom({
      roomId: 'room-reject',
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const epoch = Number(created.epochState.epoch);
    const devB = await p2p.generateDeviceSigningKeyPair();
    const devBPub = p2p.toBase64Url(await p2p.exportPublicKeyRaw(devB.publicKey));
    const rendezvous = inMemoryRendezvous();
    const link = new FakeLink();
    const base = {
      p2p,
      rendezvous,
      roomIdCommitment: created.roomIdCommitment,
      epoch,
      rendezvousKey: created.epochState.keys.rendezvousKey,
      transportMode: 'direct_allowed' as const,
      nowMs: () => Date.now(),
      pollIntervalMs: 1,
      timeoutMs: 4_000,
      rtcFactory: () => new FakePeer(link),
    } satisfies Partial<ConnectPrivatePeerParams>;

    // Alice resolves 'device-b' as ACTIVE, but bob's side resolves 'founder-dev' as
    // UNKNOWN (returns undefined) — so alice's proof is rejected by bob, and both reject.
    const aliceConnect = connectPrivatePeer({
      ...base,
      selfDeviceId: 'founder-dev',
      selfSigningKey: created.founder.signingKeyPair.privateKey,
      resolveDevice: (id) =>
        id === 'device-b' ? { signingPublicKey: devBPub, activeAtEpoch: true } : undefined,
    });
    const bobConnect = connectPrivatePeer({
      ...base,
      selfDeviceId: 'device-b',
      selfSigningKey: devB.privateKey,
      resolveDevice: () => undefined, // 'founder-dev' is unknown to bob ⇒ reject
    });
    await expect(Promise.all([aliceConnect, bobConnect])).rejects.toThrow(
      /handshake rejected|unknown_device|timed out|aborted/,
    );
  });

  it('FAILS FAST (relay_without_turn) when relay-only mode has no TURN server', async () => {
    const p2p = await import('@licio/private-p2p');
    const created = await p2p.createPrivateRoom({
      roomId: 'room-relay',
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    // relay-only with NO iceServers ⇒ no TURN ⇒ would gather zero candidates ⇒ silent
    // timeout.  The carrier instead rejects immediately + typed (before any announce).
    await expect(
      connectPrivatePeer({
        p2p,
        rendezvous: inMemoryRendezvous(),
        roomIdCommitment: created.roomIdCommitment,
        epoch: Number(created.epochState.epoch),
        rendezvousKey: created.epochState.keys.rendezvousKey,
        selfDeviceId: 'founder-dev',
        selfSigningKey: created.founder.signingKeyPair.privateKey,
        resolveDevice: () => undefined,
        transportMode: 'relay_only',
        nowMs: () => Date.now(),
        timeoutMs: 2_000,
        rtcFactory: () => new FakePeer(new FakeLink()),
      }),
    ).rejects.toThrow(/requires a TURN server/);
  });

  it('Tier-2 cap SKIPS a flood of fake-cap announcements (no dial is ever attempted)', async () => {
    const p2p = await import('@licio/private-p2p');
    const cap = await import('@licio/private-p2p/rendezvous-cap');
    const created = await p2p.createPrivateRoom({
      roomId: 'room-flood',
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const epoch = Number(created.epochState.epoch);
    const rendezvousKey = created.epochState.keys.rendezvousKey;

    // The legit member's hooks verify under the LEGIT issuer key.
    const legitIssuer = cap.RendezvousIssuer.generate(String(epoch));
    const legitMember = new cap.RendezvousMember();
    legitMember.installCredential(
      String(epoch),
      legitIssuer.issueForCommitment(legitMember.commitment),
      legitIssuer.publicKey,
    );
    const issuerKey = legitMember.issuerKey(String(epoch));
    if (!issuerKey) throw new Error('member not enrolled');
    const issuerPk = cap.issuerKeyFromBytes(issuerKey);
    const hooks = {
      build: (rb: string, e: number, b: number) => cap.buildAnnouncementCap(legitMember, rb, e, b),
      filterVerified: (
        caps: ReadonlyArray<{ proof: string; pseudonym: string }>,
        rb: string,
        e: number,
        b: number,
        now: number,
      ): number[] =>
        cap
          .filterVerifiedPresence(
            caps.map((c, i) => ({
              pseudonym: cap.fromBase64Url(c.pseudonym),
              proof: cap.fromBase64Url(c.proof),
              epoch: String(e),
              bucket: b,
              value: i,
            })),
            issuerPk,
            new TextEncoder().encode(rb),
            { nowMs: now },
          )
          .map((v) => v.value),
    };

    // A FLOODER enrolled under a DIFFERENT issuer → its (well-formed) caps never verify under
    // the legit issuer key, so every one of its announcements is skipped.
    const floodIssuer = cap.RendezvousIssuer.generate(String(epoch));
    const floodMember = new cap.RendezvousMember();
    floodMember.installCredential(
      String(epoch),
      floodIssuer.issueForCommitment(floodMember.commitment),
      floodIssuer.publicKey,
    );
    const timeBucket = p2p.rendezvousTimeBucket(Date.now());
    const roomBlindId = await p2p.deriveRoomBlindId(rendezvousKey, epoch, timeBucket);
    const floodCap = cap.buildAnnouncementCap(floodMember, roomBlindId, epoch, timeBucket);
    if (!floodCap) throw new Error('flood cap not built');

    const sig = p2p.toBase64Url((await p2p.generateX25519KeyPair()).publicKey);
    const rendezvous = inMemoryRendezvous();
    for (let i = 0; i < 20; i++) {
      await rendezvous.announce(
        await p2p.buildRendezvousRecord({
          rendezvousKey,
          epoch,
          timeBucket,
          deviceId: `flood-${i}`,
          announcement: {
            schema: 'licio.private.rendezvous_announcement.v1',
            peer_device_id: `flood-${i}`,
            signaling_public_key: sig,
            transport_hints: [],
            cap: floodCap,
          },
          nowMs: Date.now(),
        }),
      );
    }

    let rtcCreated = 0;
    const base = {
      p2p,
      rendezvous,
      roomIdCommitment: created.roomIdCommitment,
      epoch,
      rendezvousKey,
      selfDeviceId: 'founder-dev',
      selfSigningKey: created.founder.signingKeyPair.privateKey,
      resolveDevice: (id: string) =>
        id.startsWith('flood-') ? { signingPublicKey: sig, activeAtEpoch: true } : undefined,
      transportMode: 'direct_allowed' as const,
      nowMs: () => Date.now(),
      pollIntervalMs: 1,
      timeoutMs: 400,
      rtcFactory: () => {
        rtcCreated++;
        return new FakePeer(new FakeLink());
      },
    } satisfies Partial<ConnectPrivatePeerParams>;

    // WITH the cap hooks: every fake is rejected at verify → no peer is ever chosen → the
    // dial path (rtcFactory) is NEVER reached.
    await expect(connectPrivatePeer({ ...base, rendezvousCap: hooks })).rejects.toThrow(
      /timed out/,
    );
    expect(rtcCreated).toBe(0);

    // WITHOUT the cap: the carrier would pick a fake and attempt to dial it — the cap is
    // exactly what prevents the flooder from consuming the dial budget.
    rtcCreated = 0;
    await expect(connectPrivatePeer({ ...base })).rejects.toThrow();
    expect(rtcCreated).toBeGreaterThan(0);
  });
});
