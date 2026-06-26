// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.3 (carrier resilience) — §15.4 ICE-restart recovery in `connectPrivatePeer`.
// A TRANSIENT path failure (NAT rebinding, a Wi-Fi↔cellular handover) surfaces on a real
// `RTCPeerConnection` as a `connectionState` of `disconnected`/`failed` while the data
// channel stays open.  The carrier recovers it IN PLACE — the offerer re-offers with
// `iceRestart` over the still-live sealed signaling and the answerer renegotiates — keeping
// the SAME data channel + the membership-proven §15.5 session key, never re-running the
// handshake.  Only a hard, unrecoverable drop closes the channel → `maintainConnection`
// re-dials.
//
// These tests drive that against a faithful fake `RTCPeerConnection` pair that models
// connection-state transitions + `restartIce()` + a renegotiation re-offer/answer (the data
// channel is NOT recreated on a re-offer, mirroring a real ICE restart).

import { describe, expect, it } from 'vitest';
import {
  type ConnectPrivatePeerParams,
  connectPrivatePeer,
  type RtcDataChannelLike,
  type RtcIceCandidateInit,
  type RtcOfferOptionsLike,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionInit,
} from '../connect-peer.js';
import type { PresenceRecord, RendezvousTransport, WireSignal } from '../rendezvous-client.js';
import type { PeerChannel } from '../sync-session.js';

const PROFILE = { name: 'ICE Restart', room_type: 'global_topic' } as const;

// --- a fake RTCPeerConnection pair that models ICE-restart recovery ------------------

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

class FakePeer implements RtcPeerConnectionLike {
  onicecandidate: ((event: { candidate: RtcIceCandidateInit | null }) => void) | null = null;
  ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';
  iceConnectionState = 'new';
  // Instrumentation the tests assert on.
  isOfferer = false;
  restartIceCalls = 0;
  iceRestartOffers = 0;
  closed = false;
  /** When false, an ICE restart does NOT recover the path — applying the re-answer keeps the
   *  connection `disconnected` and each restart re-offer re-emits a fresh failure event (as a
   *  real RTCPeerConnection does when a restart attempt fails to reconnect), so the watcher's
   *  bounded-retry cap is exercised. */
  healOnRestart = true;
  /** When true, the FIRST applied answer silently flips the connection to `disconnected` WITHOUT
   *  dispatching a state-change event — modelling a path that goes bad DURING the §15.5 handshake,
   *  so by the time the ICE-restart watcher installs the event has already fired.  One-shot: the
   *  restart's re-answer heals normally. */
  silentDisconnectOnFirstAnswer = false;
  private answersApplied = 0;
  constructor(private readonly link: FakeLink) {}
  createDataChannel(): RtcDataChannelLike {
    const ch = new FakeChannel();
    this.link.offererChannel = ch; // calling this ⇒ we are the offerer
    this.isOfferer = true;
    return ch;
  }
  async createOffer(options?: RtcOfferOptionsLike): Promise<RtcSessionDescriptionInit> {
    if (options?.iceRestart) {
      this.iceRestartOffers += 1;
      // Model a restart that does NOT reconnect: re-emit a failure so the watcher retries
      // (until it hits its bounded cap), mirroring a real browser's failed→checking→failed.
      if (!this.healOnRestart) queueMicrotask(() => this.setConnectionState('disconnected'));
    }
    return { type: 'offer', sdp: options?.iceRestart ? 'v=0\r\nrestart-offer' : 'v=0\r\noffer' };
  }
  async createAnswer(): Promise<RtcSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0\r\nanswer' };
  }
  async setLocalDescription(): Promise<void> {
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
      // First offer ⇒ create the answerer's data channel.  A RE-offer (ICE restart) must NOT
      // recreate it — the SCTP/DTLS association survives an ICE restart.
      if (!this.link.answererChannel) {
        const ch = new FakeChannel();
        this.link.answererChannel = ch;
        queueMicrotask(() => this.ondatachannel?.({ channel: ch }));
      }
    } else if (description.type === 'answer') {
      this.link.answerExchanged = true;
      this.link.maybeOpen();
      this.answersApplied += 1;
      if (this.silentDisconnectOnFirstAnswer && this.answersApplied === 1) {
        // The path went bad mid-handshake: be `disconnected` by watcher-install time, with NO
        // state-change event fired afterward (so only a self-driven install-time check recovers it).
        this.connectionState = 'disconnected';
        this.iceConnectionState = 'disconnected';
        return;
      }
      // Applying an answer brings (or restores) the offerer to a live connection — unless this
      // peer is modelling a path that never heals (the bounded-retry test).  A successful restart
      // restores BOTH state machines (the ICE path AND the connection).
      if (this.healOnRestart) {
        this.iceConnectionState = 'connected';
        this.setConnectionState('connected');
      }
    }
  }
  async addIceCandidate(): Promise<void> {
    /* the fake opens on SDP exchange; ICE candidates are conveyed but not needed to link */
  }
  restartIce(): void {
    this.restartIceCalls += 1;
  }
  setConnectionState(state: string): void {
    this.connectionState = state;
    queueMicrotask(() => {
      this.onconnectionstatechange?.();
      this.oniceconnectionstatechange?.();
    });
  }
  /** Drive ONLY the ICE state machine — `connectionState` is left as-is, modelling the real case
   *  where ICE flips to `failed`/`disconnected` while the connection-level state still lags. */
  setIceConnectionState(state: string): void {
    this.iceConnectionState = state;
    queueMicrotask(() => this.oniceconnectionstatechange?.());
  }
  close(): void {
    this.closed = true;
    // A real `pc.close()` drops the SCTP association → the data channel `onclose` fires on BOTH
    // ends (each peer observes the drop), which is the signal `maintainConnection`/`maintainMesh`
    // re-dial on.  Model that so a teardown is observable regardless of which side closed.
    this.link.offererChannel?.close();
    this.link.answererChannel?.close();
  }
}

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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 4_000; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

interface ConnectedPair {
  a: { channel: PeerChannel; peerDeviceId: string };
  b: { channel: PeerChannel; peerDeviceId: string };
  peers: FakePeer[];
  offerer(): FakePeer;
}

async function connectPair(
  overrides: Partial<ConnectPrivatePeerParams> = {},
  prepPeer?: (pc: FakePeer) => void,
): Promise<ConnectedPair> {
  const p2p = await import('@licio/private-p2p');
  const created = await p2p.createPrivateRoom({
    roomId: 'room-ice',
    founderMemberId: 'founder',
    founderDeviceId: 'founder-dev',
    profile: PROFILE,
  });
  const epoch = Number(created.epochState.epoch);
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

  const rendezvous = inMemoryRendezvous();
  const link = new FakeLink();
  const peers: FakePeer[] = [];
  const base = {
    p2p,
    rendezvous,
    roomIdCommitment: created.roomIdCommitment,
    epoch,
    rendezvousKey: created.epochState.keys.rendezvousKey,
    transportMode: 'direct_allowed' as const,
    nowMs: () => Date.now(),
    pollIntervalMs: 1,
    maintenancePollMs: 1,
    iceRestartGraceMs: 3,
    timeoutMs: 4_000,
    rtcFactory: () => {
      const pc = new FakePeer(link);
      prepPeer?.(pc);
      peers.push(pc);
      return pc;
    },
    ...overrides,
  } satisfies Partial<ConnectPrivatePeerParams>;

  const [a, b] = await Promise.all([
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
  return { a, b, peers, offerer: () => peers.find((pc) => pc.isOfferer) as FakePeer };
}

describe('WS-S.4.3 connectPrivatePeer — §15.4 ICE-restart recovery', () => {
  it('recovers a transient disconnect IN PLACE (re-offer; same channel + session key)', async () => {
    const { a, b, offerer } = await connectPair();
    const off = offerer();
    expect(off.isOfferer).toBe(true);
    expect(off.iceRestartOffers).toBe(0); // no restart yet

    // A frame flows on the healthy connection.
    let first: number[] | null = null;
    b.channel.onMessage((f) => {
      first = Array.from(f);
    });
    await Promise.resolve(a.channel.send(new Uint8Array([1, 2, 3])));
    await waitFor(() => first !== null, 'first frame');
    expect(first).toEqual([1, 2, 3]);

    // A transient path failure: the offerer's connection goes `disconnected`.  The watcher
    // waits out the grace, then re-offers with iceRestart; the answerer renegotiates and the
    // offerer is brought back to `connected` (setRemoteDescription(answer) in the fake).
    off.setConnectionState('disconnected');
    await waitFor(() => off.iceRestartOffers > 0, 'an ICE-restart re-offer');
    await waitFor(() => off.connectionState === 'connected', 'recovery to connected');
    expect(off.restartIceCalls).toBeGreaterThan(0); // restartIce() was also called
    expect(off.closed).toBe(false); // the connection was NOT torn down

    // The SAME channel still delivers AFTER the restart — the session key was preserved
    // (a re-handshake would have produced a new key and the frame would not open).
    let second: number[] | null = null;
    b.channel.onMessage((f) => {
      second = Array.from(f);
    });
    await Promise.resolve(a.channel.send(new Uint8Array([4, 5, 6])));
    await waitFor(() => second !== null, 'post-restart frame');
    expect(second).toEqual([4, 5, 6]);

    a.channel.close();
    b.channel.close();
  });

  it('bounds restart attempts AND tears the connection down on exhaustion (→ re-dial)', async () => {
    const { a, b, offerer } = await connectPair({ maxIceRestarts: 2, iceRestartGraceMs: 2 });
    const off = offerer();
    // The channel `onClose` is the signal `maintainConnection`/`maintainMesh` re-dial on.
    let channelClosed = false;
    expect(a.channel.onClose).toBeDefined();
    a.channel.onClose?.(() => {
      channelClosed = true;
    });
    // Model a path that never heals: each restart re-emits a fresh failure, so the watcher
    // keeps trying until it hits the bounded cap.
    off.healOnRestart = false;
    off.setConnectionState('disconnected');
    // It attempts exactly maxIceRestarts times, then STOPS (no infinite loop).
    await waitFor(() => off.iceRestartOffers >= 2, 'two restart attempts');
    // On exhaustion it must NOT silently strand a dead connection — it tears the pc down…
    await waitFor(() => off.closed, 'pc closed after exhaustion');
    // …so the channel `onClose` fires (the re-dial trigger), and the cap is not exceeded.
    await waitFor(() => channelClosed, 'channel onClose fired (re-dial signal)');
    for (let i = 0; i < 50; i++) await tick();
    expect(off.iceRestartOffers).toBe(2); // capped, no overshoot after teardown

    b.channel.close();
  });

  it('does not ICE-restart when disabled', async () => {
    const { a, b, offerer } = await connectPair({ enableIceRestart: false });
    const off = offerer();
    off.setConnectionState('disconnected');
    for (let i = 0; i < 60; i++) await tick();
    expect(off.iceRestartOffers).toBe(0);
    expect(off.restartIceCalls).toBe(0);

    a.channel.close();
    b.channel.close();
  });

  it('only the OFFERER initiates the restart (the answerer never re-offers)', async () => {
    const { a, b, peers, offerer } = await connectPair();
    const off = offerer();
    const answerer = peers.find((pc) => !pc.isOfferer) as FakePeer;
    // Force BOTH sides to observe the blip; only the offerer should re-offer.
    answerer.setConnectionState('disconnected');
    off.setConnectionState('disconnected');
    await waitFor(() => off.iceRestartOffers > 0, 'offerer re-offers');
    // The answerer must not have created an iceRestart offer of its own.
    expect(answerer.iceRestartOffers).toBe(0);

    a.channel.close();
    b.channel.close();
  });

  it('recovers a path that was ALREADY bad when the watcher installed (no later event)', async () => {
    // If the connection went `disconnected` DURING the §15.5 handshake, the state-change event has
    // already fired by the time the watcher installs; merely assigning the handlers would never
    // invoke recovery.  The watcher must self-drive once on install, so an already-bad path starts
    // an ICE restart immediately rather than stranding the live signaling pump until some later
    // transition (which a stuck `disconnected` path may never deliver).
    const { a, b, offerer } = await connectPair({ iceRestartGraceMs: 2 }, (pc) => {
      pc.silentDisconnectOnFirstAnswer = true;
    });
    const off = offerer();
    // No state-change event fired after install — yet recovery still starts (the re-offer), driven
    // solely by the install-time self-check.  Without it this would hang at 0 forever.
    await waitFor(() => off.iceRestartOffers > 0, 'recovery started from the already-bad state');
    // The one-shot disconnect heals on the restart answer, so the connection comes back in place.
    await waitFor(() => off.connectionState === 'connected', 'recovery to connected in place');
    expect(off.closed).toBe(false);

    a.channel.close();
    b.channel.close();
  });

  it('an ICE-only failure (connectionState still `connected`) is NOT masked as recovered', async () => {
    // The exact case ICE-restart exists for: `iceConnectionState` flips to `failed` while
    // `connectionState` still reads `connected`.  isRecovered() must treat the bad ICE state as
    // a real failure (not mask it via the healthy connectionState), so the offerer re-offers.
    const { a, b, offerer } = await connectPair();
    const off = offerer();
    expect(off.connectionState).toBe('connected');

    off.setIceConnectionState('failed'); // connectionState stays 'connected'
    await waitFor(
      () => off.iceRestartOffers > 0,
      'an ICE-restart re-offer for the ICE-only failure',
    );
    // The restart restores both machines; the connection is recovered in place, not torn down.
    await waitFor(
      () => off.iceConnectionState === 'connected' && off.connectionState === 'connected',
      'recovery of both state machines',
    );
    expect(off.closed).toBe(false);

    a.channel.close();
    b.channel.close();
  });
});
