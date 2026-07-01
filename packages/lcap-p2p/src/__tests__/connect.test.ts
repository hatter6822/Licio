// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.6a — `connectWebrtc` live-establishment orchestration.  A faithful fake
// RTCPeerConnection pair + an in-memory server-blind signaling relay drive two real
// `connectWebrtc` calls (initiator + responder) to a converged data channel, then the
// resulting WebrtcTransports exchange a byte payload end-to-end.  The fake exercises the
// REAL orchestration: offer→answer over the SEALED signaling rendezvous, trickled ICE
// with pre-remote-description buffering, datachannel-open wait, and teardown.

import { describe, expect, it } from 'vitest';
import {
  type ConnectableDataChannel,
  connectWebrtc,
  decideWebrtc,
  decodeSignalEnvelope,
  encodeSignalEnvelope,
  importSignalKey,
  type RtcConfigurationLike,
  type RtcIceCandidateInit,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionInit,
  sealSignal,
  WebrtcTransport,
} from '../index.js';

// --- a paired fake data channel ----------------------------------------------------
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

// A shared "DTLS link" the two fake peers complete out of band (the real datachannel
// opening). It pairs + opens both channels once offer/answer have been exchanged.
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
  iceConnectionState = 'new';
  closeCount = 0;
  /** Fire one more local ICE candidate after `delayMs` (to model a late trickle). */
  fireLateCandidate(delayMs: number): void {
    setTimeout(() => {
      this.onicecandidate?.({
        candidate: { candidate: `candidate:late-${this.role}`, sdpMid: '0', sdpMLineIndex: 0 },
      });
    }, delayMs);
  }
  constructor(
    private readonly link: FakeLink,
    private readonly role: 'initiator' | 'responder',
    readonly config: RtcConfigurationLike,
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
    // Emit one local ICE candidate so the trickle path is exercised.
    queueMicrotask(() =>
      this.onicecandidate?.({
        candidate: { candidate: `candidate:${this.role}`, sdpMid: '0', sdpMLineIndex: 0 },
      }),
    );
    // Then the gathering-complete null candidate.
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
  iceCandidates: RtcIceCandidateInit[] = [];
  async addIceCandidate(candidate: RtcIceCandidateInit): Promise<void> {
    this.iceCandidates.push(candidate);
  }
  close(): void {
    this.iceConnectionState = 'closed';
    this.closeCount += 1;
  }
}

// --- in-memory server-blind relay --------------------------------------------------
function makeRelay() {
  const mailboxes = new Map<string, Uint8Array[]>();
  const postCounts = new Map<string, number>();
  return {
    postSignal: async (to: string, body: Uint8Array): Promise<void> => {
      const box = mailboxes.get(to) ?? [];
      box.push(body);
      mailboxes.set(to, box);
      postCounts.set(to, (postCounts.get(to) ?? 0) + 1);
    },
    /** Total POSTs ever addressed to `to` (mailbox length is drained by polling; this is not). */
    postsTo: (to: string): number => postCounts.get(to) ?? 0,
    pollSignal: async (self: string): Promise<readonly Uint8Array[]> => {
      const box = mailboxes.get(self) ?? [];
      mailboxes.set(self, []);
      return box;
    },
    mailboxes,
  };
}

const KEY_BYTES = new Uint8Array(32).fill(3);
const ROOM = new Uint8Array(16).fill(9);

async function allow(relayOnly = false): Promise<ReturnType<typeof decideWebrtc>> {
  return decideWebrtc({
    mode: relayOnly ? 'relay' : 'standard',
    userEnabled: true,
    ...(relayOnly ? { relayOnlyIce: true, turnServers: [{ urls: 'turn:turn.example' }] } : {}),
  });
}

describe('WS-R.15.6a connectWebrtc', () => {
  it('establishes a data channel via the sealed rendezvous and exchanges bytes', async () => {
    const link = new FakeLink();
    const relay = makeRelay();
    const key = await importSignalKey(KEY_BYTES);
    const decision = await allow();
    const common = {
      decision,
      signalKey: key,
      roomIdHash: ROOM,
      postSignal: relay.postSignal,
      pollSignal: relay.pollSignal,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    };

    const [chA, chB] = await Promise.all([
      connectWebrtc({
        ...common,
        selfPeerKey: 'alice',
        remotePeerKey: 'bob',
        initiator: true,
        rtcFactory: (config) => new FakePeer(link, 'initiator', config),
      }),
      connectWebrtc({
        ...common,
        selfPeerKey: 'bob',
        remotePeerKey: 'alice',
        initiator: false,
        rtcFactory: (config) => new FakePeer(link, 'responder', config),
      }),
    ]);

    expect(chA.readyState).toBe('open');
    expect(chB.readyState).toBe('open');

    // The two channels carry an LCAP exchange end-to-end through WebrtcTransport.
    const ta = new WebrtcTransport(chA);
    const tb = new WebrtcTransport(chB);
    await ta.open();
    await tb.open();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const received = tb.receive();
    await ta.send(payload);
    expect(Array.from((await received) ?? [])).toEqual([1, 2, 3, 4, 5]);
    await ta.close();
    await tb.close();
  });

  it('carries a LARGE multi-fragment pack byte-identically over the live channel', async () => {
    const link = new FakeLink();
    const relay = makeRelay();
    const key = await importSignalKey(KEY_BYTES);
    const decision = await allow();
    const common = {
      decision,
      signalKey: key,
      roomIdHash: ROOM,
      postSignal: relay.postSignal,
      pollSignal: relay.pollSignal,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    };

    const [chA, chB] = await Promise.all([
      connectWebrtc({
        ...common,
        selfPeerKey: 'alice',
        remotePeerKey: 'bob',
        initiator: true,
        rtcFactory: (config) => new FakePeer(link, 'initiator', config),
      }),
      connectWebrtc({
        ...common,
        selfPeerKey: 'bob',
        remotePeerKey: 'alice',
        initiator: false,
        rtcFactory: (config) => new FakePeer(link, 'responder', config),
      }),
    ]);

    const ta = new WebrtcTransport(chA);
    const tb = new WebrtcTransport(chB);
    await ta.open();
    await tb.open();
    // A ~50 KiB pack: several full 16 KiB fragments + a tail (modelling a multi-block pack).
    const pack = new Uint8Array(50 * 1024);
    for (let i = 0; i < pack.length; i++) pack[i] = (i * 17 + 3) & 0xff;
    const received = tb.receive();
    await ta.send(pack);
    const got = await received;
    expect(got).not.toBeNull();
    expect(got?.length).toBe(pack.length);
    expect(got).toEqual(pack);
    await ta.close();
    await tb.close();
  });

  it('aborts the transport fail-closed on a malformed inbound fragment', async () => {
    // A peer that emits a single junk datachannel message (bad fragment header) must not be
    // able to mis-stitch a partial message: the receiving transport tears down + yields null.
    const ch = {
      readyState: 'open' as 'connecting' | 'open' | 'closing' | 'closed',
      binaryType: 'arraybuffer',
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onclose: null as (() => void) | null,
      send() {},
      close() {
        this.readyState = 'closed';
      },
    };
    const t = new WebrtcTransport(ch);
    const pending = t.receive();
    // An over-cap-version garbage fragment (version byte != 1) — fatal.
    const junk = new Uint8Array(17 + 1);
    junk[0] = 9;
    ch.onmessage?.({ data: junk.buffer });
    expect(await pending).toBeNull();
    expect(ch.readyState).toBe('closed');
  });

  it('refuses to connect when the decision disallows WebRTC', async () => {
    const relay = makeRelay();
    const key = await importSignalKey(KEY_BYTES);
    const offByDefault = decideWebrtc({ mode: 'standard', userEnabled: false });
    await expect(
      connectWebrtc({
        decision: offByDefault,
        signalKey: key,
        roomIdHash: ROOM,
        selfPeerKey: 'a',
        remotePeerKey: 'b',
        initiator: true,
        postSignal: relay.postSignal,
        pollSignal: relay.pollSignal,
        rtcFactory: (config) => new FakePeer(new FakeLink(), 'initiator', config),
      }),
    ).rejects.toThrow(/disallowed/);
  });

  it('fails closed with ZERO egress on an already-aborted caller signal (PUB-WEBRTC-ABORT)', async () => {
    const relay = makeRelay();
    const key = await importSignalKey(KEY_BYTES);
    const controller = new AbortController();
    controller.abort(); // aborted BEFORE the dial — addEventListener('abort') would never fire
    let pcConstructed = false;
    await expect(
      connectWebrtc({
        decision: await allow(),
        signalKey: key,
        roomIdHash: ROOM,
        selfPeerKey: 'a',
        remotePeerKey: 'b',
        initiator: true,
        postSignal: relay.postSignal,
        pollSignal: relay.pollSignal,
        signal: controller.signal,
        rtcFactory: (config) => {
          pcConstructed = true;
          return new FakePeer(new FakeLink(), 'initiator', config);
        },
      }),
    ).rejects.toThrow(/aborted/);
    // No RTCPeerConnection is constructed and NOTHING is sealed + POSTed to the relay: an
    // already-aborted dial produces no offer/ICE signaling egress at all.
    expect(pcConstructed).toBe(false);
    expect(relay.postsTo('b')).toBe(0);
  });

  it('a responder aborted DURING offer handling posts NO answer (PUB-WEBRTC-ABORT-BATCH)', async () => {
    const link = new FakeLink();
    const relay = makeRelay();
    const key = await importSignalKey(KEY_BYTES);
    const decision = await allow();
    const controller = new AbortController();
    const common = {
      decision,
      signalKey: key,
      roomIdHash: ROOM,
      postSignal: relay.postSignal,
      pollSignal: relay.pollSignal,
      pollIntervalMs: 1,
      timeoutMs: 300,
    };
    // The responder aborts MID-offer-handling — inside `createAnswer`, after `setRemoteDescription`
    // and before the answer is posted — so the offer-branch guard must suppress the answer egress
    // (the async awaits between the batch-abort check and the post let the abort slip through before).
    class AbortingResponder extends FakePeer {
      override async createAnswer(): Promise<RtcSessionDescriptionInit> {
        controller.abort();
        return super.createAnswer();
      }
    }
    await Promise.allSettled([
      connectWebrtc({
        ...common,
        selfPeerKey: 'alice',
        remotePeerKey: 'bob',
        initiator: true,
        rtcFactory: (config) => new FakePeer(link, 'initiator', config),
      }),
      connectWebrtc({
        ...common,
        selfPeerKey: 'bob',
        remotePeerKey: 'alice',
        initiator: false,
        signal: controller.signal,
        rtcFactory: (config) => new AbortingResponder(link, 'responder', config),
      }),
    ]);
    // The aborted responder sealed + POSTed NOTHING back to the initiator — no answer, no ICE.
    expect(relay.postsTo('alice')).toBe(0);
  });

  it('applies relay-only iceTransportPolicy to the RTCConfiguration', async () => {
    const relay = makeRelay();
    const key = await importSignalKey(KEY_BYTES);
    const decision = await allow(true);
    let seenConfig: RtcConfigurationLike | undefined;
    const link = new FakeLink();
    // Only the initiator; it will time out fast (no peer answers) — we only assert config.
    await expect(
      connectWebrtc({
        decision,
        signalKey: key,
        roomIdHash: ROOM,
        selfPeerKey: 'a',
        remotePeerKey: 'b',
        initiator: true,
        postSignal: relay.postSignal,
        pollSignal: relay.pollSignal,
        pollIntervalMs: 1,
        timeoutMs: 60,
        rtcFactory: (config) => {
          seenConfig = config;
          return new FakePeer(link, 'initiator', config);
        },
      }),
    ).rejects.toThrow(/aborted/);
    expect(seenConfig?.iceTransportPolicy).toBe('relay');
  });

  it('discards a misrouted frame (the server-blind relay only forwards opaque bytes)', async () => {
    // A frame addressed to someone else must never be opened/acted on.
    const relay = makeRelay();
    const key = await importSignalKey(KEY_BYTES);
    const decision = await allow();
    // A WELL-FORMED frame sealed for a DIFFERENT recipient ('z') — `to !== self`.
    const env = await sealSignal({
      roomIdHash: ROOM,
      from: 'z',
      to: 'z',
      payload: new Uint8Array([0]),
      key,
    });
    const frame = encodeSignalEnvelope(env);
    // Sanity: the frame decodes cleanly, so the discard below is on routing (`to`), not a parse error.
    expect(() => decodeSignalEnvelope(frame)).not.toThrow();
    await relay.postSignal('a', frame);
    // connectWebrtc('a') drains + discards the misrouted frame and (no responder) times out.
    const link = new FakeLink();
    await expect(
      connectWebrtc({
        decision,
        signalKey: key,
        roomIdHash: ROOM,
        selfPeerKey: 'a',
        remotePeerKey: 'b',
        initiator: true,
        postSignal: relay.postSignal,
        pollSignal: relay.pollSignal,
        pollIntervalMs: 1,
        timeoutMs: 60,
        rtcFactory: (config) => new FakePeer(link, 'initiator', config),
      }),
    ).rejects.toThrow(/aborted/);
  });

  it('does NOT post the offer when aborted during createOffer/setLocalDescription', async () => {
    // If the RTC offer setup outlasts the timeout (or the caller aborts mid-await), the offer must
    // NOT be sealed + POSTed afterwards — that would be post-cancel signaling egress that wakes the
    // remote for a connection this side is already tearing down.
    const relay = makeRelay();
    const key = await importSignalKey(KEY_BYTES);
    const decision = await allow();
    const link = new FakeLink();
    await expect(
      connectWebrtc({
        decision,
        signalKey: key,
        roomIdHash: ROOM,
        selfPeerKey: 'a',
        remotePeerKey: 'b',
        initiator: true,
        postSignal: relay.postSignal,
        pollSignal: relay.pollSignal,
        pollIntervalMs: 1,
        timeoutMs: 20, // fires DURING the slow setLocalDescription below
        rtcFactory: (config) => {
          const pc = new FakePeer(link, 'initiator', config);
          const realSet = pc.setLocalDescription.bind(pc);
          pc.setLocalDescription = async (): Promise<void> => {
            await new Promise((r) => setTimeout(r, 60)); // outlasts timeoutMs ⇒ aborts mid-await
            return realSet();
          };
          return pc;
        },
      }),
    ).rejects.toThrow(/aborted/);
    // The timer aborted during setLocalDescription, so the offer was never sealed + POSTed.
    expect(relay.postsTo('b')).toBe(0);
  });

  it('does NOT leave an unhandled channelReady rejection when the offer POST fails', async () => {
    // If the initiator's offer `sendSignal` rejects (e.g. offline), the function throws before
    // it ever awaits `channelReady`; the `finally`'s `controller.abort()` then rejects
    // `channelReady` with no awaiter.  A defensive catch must keep that from becoming a global
    // unhandled rejection — `connectWebrtc` still rejects with the underlying POST error.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const key = await importSignalKey(KEY_BYTES);
      const decision = await allow();
      const link = new FakeLink();
      await expect(
        connectWebrtc({
          decision,
          signalKey: key,
          roomIdHash: ROOM,
          selfPeerKey: 'a',
          remotePeerKey: 'b',
          initiator: true,
          postSignal: async () => {
            throw new Error('offline');
          },
          pollSignal: async () => [],
          pollIntervalMs: 1,
          timeoutMs: 1000,
          rtcFactory: (config) => new FakePeer(link, 'initiator', config),
        }),
      ).rejects.toThrow(/offline/);
      // Let any microtask-deferred unhandled rejection surface before asserting there is none.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('closes the underlying RTCPeerConnection when the opened channel is closed', async () => {
    // The channel rides on `pc`; closing the transport must tear down the peer connection
    // too (otherwise the RTCPeerConnection + ICE agent leak for the life of the tab).
    const link = new FakeLink();
    const relay = makeRelay();
    const key = await importSignalKey(KEY_BYTES);
    const decision = await allow();
    let initiatorPeer: FakePeer | undefined;
    const common = {
      decision,
      signalKey: key,
      roomIdHash: ROOM,
      postSignal: relay.postSignal,
      pollSignal: relay.pollSignal,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    };
    const [chA, chB] = await Promise.all([
      connectWebrtc({
        ...common,
        selfPeerKey: 'alice',
        remotePeerKey: 'bob',
        initiator: true,
        rtcFactory: (config) => {
          initiatorPeer = new FakePeer(link, 'initiator', config);
          return initiatorPeer;
        },
      }),
      connectWebrtc({
        ...common,
        selfPeerKey: 'bob',
        remotePeerKey: 'alice',
        initiator: false,
        rtcFactory: (config) => new FakePeer(link, 'responder', config),
      }),
    ]);
    const ta = new WebrtcTransport(chA);
    expect(initiatorPeer?.closeCount).toBe(0); // still live while the channel is open
    await ta.close();
    expect(initiatorPeer?.closeCount).toBeGreaterThan(0); // closing the channel closed pc
    await new WebrtcTransport(chB).close();
  });

  it('tears down pc and stops ICE egress once aborted/timed-out', async () => {
    // No responder ⇒ the initiator times out.  On that non-success path pc must be closed,
    // and a LATE ICE candidate firing after teardown must NOT seal+POST to the relay.
    const relay = makeRelay();
    const key = await importSignalKey(KEY_BYTES);
    const decision = await allow();
    const link = new FakeLink();
    let peer: FakePeer | undefined;
    await expect(
      connectWebrtc({
        decision,
        signalKey: key,
        roomIdHash: ROOM,
        selfPeerKey: 'a',
        remotePeerKey: 'b',
        initiator: true,
        postSignal: relay.postSignal,
        pollSignal: relay.pollSignal,
        pollIntervalMs: 1,
        timeoutMs: 60,
        rtcFactory: (config) => {
          peer = new FakePeer(link, 'initiator', config);
          return peer;
        },
      }),
    ).rejects.toThrow(/aborted/);
    expect(peer?.closeCount).toBeGreaterThan(0); // pc torn down on the non-success path
    const postsBefore = relay.postsTo('b');
    // A late trickle candidate after teardown: the aborted-guard must drop it (no egress).
    peer?.onicecandidate?.({
      candidate: { candidate: 'candidate:late', sdpMid: '0', sdpMLineIndex: 0 },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(relay.postsTo('b')).toBe(postsBefore);
  });
});
