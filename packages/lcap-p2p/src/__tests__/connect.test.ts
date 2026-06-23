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
  }
}

// --- in-memory server-blind relay --------------------------------------------------
function makeRelay() {
  const mailboxes = new Map<string, Uint8Array[]>();
  return {
    postSignal: async (to: string, body: Uint8Array): Promise<void> => {
      const box = mailboxes.get(to) ?? [];
      box.push(body);
      mailboxes.set(to, box);
    },
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
});
