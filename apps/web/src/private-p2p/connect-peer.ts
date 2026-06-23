// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.3 (carrier) — the LIVE private-room WebRTC carrier: it composes the shipped
// pure cores (blind rendezvous §15.2/15.3, the X25519-ECDH signaling channel + sealed
// SDP/ICE §15.4, the §15.5 membership-proving handshake) into a real
// `RTCPeerConnection` and yields a post-handshake `PeerChannel` that
// `PrivateRoomSession.connectPeer` drives the §15.7 op-exchange over.
//
// Trust model (fail-closed):
//   • Discovery is the capability: only a current-epoch member can derive the room
//     blind id, so a non-member can neither find nor be found (§15.3.1).
//   • SDP/ICE are E2E-sealed under the pairwise signaling key BEFORE they reach the
//     server, which routes opaque blobs only (§15.4); relay-only mode suppresses
//     IP-revealing ICE candidate types.
//   • BEFORE the channel is exposed for any op exchange, the §15.5 handshake proves the
//     remote controls a device that is REGISTERED + ACTIVE at the epoch (the room key
//     alone is not enough — a removed device's key is rejected).  A failed handshake
//     tears the connection down and rejects; no op frame is ever served first.
//
// Every dependency is injected (the `@licio/private-p2p` module, the rendezvous
// transport, the `RTCPeerConnection` factory, the clock), so the whole carrier runs in
// node tests against a fake-RTC pair + an in-memory rendezvous, and against a real
// browser `RTCPeerConnection` + the live rendezvous endpoint in the E2E.

import type { HandshakeHello, SignalingPayload } from '@licio/private-p2p';
import type { PeerChannel } from './sync-session.js';

type P2pModule = typeof import('@licio/private-p2p');

// --- minimal structural WebRTC surface (the browser `RTCPeerConnection` satisfies it) ---

export interface RtcSessionDescriptionInit {
  readonly type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  readonly sdp?: string;
}
export interface RtcIceCandidateInit {
  readonly candidate?: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
}
export interface RtcDataChannelLike {
  binaryType: string;
  readyState: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
}
export interface RtcPeerConnectionLike {
  createDataChannel(label: string): RtcDataChannelLike;
  createOffer(): Promise<RtcSessionDescriptionInit>;
  createAnswer(): Promise<RtcSessionDescriptionInit>;
  setLocalDescription(description: RtcSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RtcSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RtcIceCandidateInit): Promise<void>;
  onicecandidate: ((event: { candidate: RtcIceCandidateInit | null }) => void) | null;
  ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null;
  close(): void;
}
export interface RtcIceServerLike {
  readonly urls: string | string[];
  readonly username?: string;
  readonly credential?: string;
}
export type RtcPeerConnectionFactory = (config: {
  iceServers?: RtcIceServerLike[];
}) => RtcPeerConnectionLike;

function defaultRtcFactory(config: { iceServers?: RtcIceServerLike[] }): RtcPeerConnectionLike {
  const Ctor = (
    globalThis as {
      RTCPeerConnection?: new (c: { iceServers?: RtcIceServerLike[] }) => RtcPeerConnectionLike;
    }
  ).RTCPeerConnection;
  if (!Ctor)
    throw new ConnectPrivatePeerError('rtc_unavailable', 'RTCPeerConnection is unavailable');
  return new Ctor(config);
}

// --- errors -------------------------------------------------------------------------

export type ConnectPrivatePeerReason =
  | 'rtc_unavailable'
  | 'timeout'
  | 'aborted'
  | 'peer_not_found'
  | `handshake_${string}`;

export class ConnectPrivatePeerError extends Error {
  constructor(
    readonly reason: ConnectPrivatePeerReason,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectPrivatePeerError';
  }
}

// --- the device resolver the §15.5 handshake consults -------------------------------

/** Resolve a claimed device id to its recorded Ed25519 signing key (base64url) +
 *  current-epoch active status — `PrivateRoomSession` derives this from
 *  `engine.state().devices`; a removed/unknown device must resolve `undefined` or
 *  `activeAtEpoch:false` so the handshake fails closed. */
export type DeviceResolver = (
  deviceId: string,
) => { readonly signingPublicKey: string; readonly activeAtEpoch: boolean } | undefined;

export interface ConnectPrivatePeerParams {
  /** The dynamically-imported `@licio/private-p2p` module (its crypto + sync fns). */
  readonly p2p: P2pModule;
  readonly rendezvous: import('./rendezvous-client.js').RendezvousTransport;
  readonly roomIdCommitment: Uint8Array;
  readonly epoch: number;
  /** The room's per-epoch §10.2 rendezvous key (the discovery capability). */
  readonly rendezvousKey: Uint8Array;
  readonly selfDeviceId: string;
  /** This device's Ed25519 signing private key (for the §15.5 membership proof). */
  readonly selfSigningKey: CryptoKey;
  readonly resolveDevice: DeviceResolver;
  /** §15.4 transport mode (relay-only suppresses IP-revealing ICE candidates). */
  readonly transportMode: 'relay_only' | 'direct_allowed';
  readonly iceServers?: RtcIceServerLike[];
  readonly nowMs: () => number;
  /** Overall connect deadline (default 30s). */
  readonly timeoutMs?: number;
  /** Rendezvous/signal poll interval (default 250ms). */
  readonly pollIntervalMs?: number;
  readonly rtcFactory?: RtcPeerConnectionFactory;
  readonly signal?: AbortSignal;
  /** A sleep primitive (injectable so tests can pump a fake clock). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const HANDSHAKE_VERSION = 1;
const SIGNAL_TTL_MS = 5 * 60_000;

interface DiscoveredPeer {
  readonly peerBlindId: string;
  readonly peerDeviceId: string;
  readonly peerSignalingPublicKey: Uint8Array;
}

/**
 * Establish a live, membership-proven `PeerChannel` to another member of the room.
 * Resolves once the WebRTC data channel is open AND the §15.5 handshake has verified
 * the remote device; rejects (tearing the connection down) on timeout, abort, or a
 * failed handshake.
 */
export async function connectPrivatePeer(params: ConnectPrivatePeerParams): Promise<PeerChannel> {
  const { p2p, rendezvous, roomIdCommitment, epoch, rendezvousKey, selfDeviceId, nowMs } = params;
  const timeoutMs = params.timeoutMs ?? 30_000;
  const pollIntervalMs = params.pollIntervalMs ?? 250;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = nowMs() + timeoutMs;
  const factory = params.rtcFactory ?? defaultRtcFactory;
  const throwIfAborted = (): void => {
    if (params.signal?.aborted) throw new ConnectPrivatePeerError('aborted', 'connect aborted');
    if (nowMs() >= deadline) throw new ConnectPrivatePeerError('timeout', 'connect timed out');
  };

  const timeBucket = p2p.rendezvousTimeBucket(nowMs());
  const roomBlindId = await p2p.deriveRoomBlindId(rendezvousKey, epoch, timeBucket);
  const selfPeerBlindId = await p2p.derivePeerBlindId(
    rendezvousKey,
    selfDeviceId,
    epoch,
    timeBucket,
  );

  // 1. Announce our presence with an ephemeral X25519 signaling key.
  const ephemeral = await p2p.generateX25519KeyPair();
  await rendezvous.announce(
    await p2p.buildRendezvousRecord({
      rendezvousKey,
      epoch,
      timeBucket,
      deviceId: selfDeviceId,
      announcement: {
        schema: 'licio.private.rendezvous_announcement.v1',
        peer_device_id: selfDeviceId,
        signaling_public_key: p2p.toBase64Url(ephemeral.publicKey),
        transport_hints: [],
      },
      nowMs: nowMs(),
    }),
  );

  // 2. Discover a peer (poll until a non-self announcement opens, or time out).
  let peer: DiscoveredPeer | undefined;
  while (!peer) {
    throwIfAborted();
    const records = await rendezvous.poll(roomBlindId);
    for (const record of records) {
      if (record.peer_blind_id === selfPeerBlindId) continue;
      try {
        const ann = await p2p.openRendezvousAnnouncement(record, rendezvousKey);
        if (ann.peer_device_id === selfDeviceId) continue;
        peer = {
          peerBlindId: record.peer_blind_id,
          peerDeviceId: ann.peer_device_id,
          peerSignalingPublicKey: p2p.fromBase64Url(ann.signaling_public_key),
        };
        break;
      } catch {
        // A §15.3.2 cover record or a record sealed for a different key: skip it.
      }
    }
    if (!peer) await sleep(pollIntervalMs);
  }

  // 3. Derive the pairwise signaling channel key (transcript-bound; both peers agree).
  const channelKey = await p2p.deriveChannelKey(
    ephemeral.privateKey,
    peer.peerSignalingPublicKey,
    {
      protocolVersion: HANDSHAKE_VERSION,
      roomIdCommitment,
      epoch,
      ephemeralPublicKeyA: ephemeral.publicKey,
      ephemeralPublicKeyB: peer.peerSignalingPublicKey,
    },
    p2p.CHANNEL_LABEL_SIGNALING,
  );

  // Deterministic role: the bytewise-smaller peer blind id offers (a stable tiebreak).
  const isOfferer = selfPeerBlindId < peer.peerBlindId;
  const pc = factory({ ...(params.iceServers ? { iceServers: params.iceServers } : {}) });

  let cleanedUp = false;
  let stopPolling = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopPolling = true;
    try {
      pc.close();
    } catch {
      /* already closed */
    }
  };

  try {
    const { dc, inbox } = await establishDataChannel({
      p2p,
      pc,
      rendezvous,
      channelKey,
      transportMode: params.transportMode,
      routing: {
        roomBlindId,
        senderBlindId: selfPeerBlindId,
        recipientBlindId: peer.peerBlindId,
      },
      selfBlindId: selfPeerBlindId,
      isOfferer,
      nowMs,
      ttlMs: SIGNAL_TTL_MS,
      pollIntervalMs,
      sleep,
      throwIfAborted,
      shouldStop: () => stopPolling,
      stop: () => {
        stopPolling = true;
      },
    });

    // 4. §15.5 membership-proving handshake over the open data channel.  Any op frames
    //    a faster peer sends before we finish are stashed (returned) for the channel.
    const opStash = await runHandshake({
      p2p,
      dc,
      inbox,
      roomIdCommitment,
      epoch,
      selfDeviceId,
      selfSigningKey: params.selfSigningKey,
      resolveDevice: params.resolveDevice,
      throwIfAborted,
      sleep,
    });

    // 5. Expose the post-handshake channel (binary frames only; handshake used strings).
    return wrapDataChannel(dc, inbox, opStash, cleanup);
  } catch (error) {
    cleanup();
    throw error;
  }
}

// --- a buffering message inbox (no frame is lost before a consumer attaches) --------

/**
 * Owns the data channel's `onmessage` from the moment it opens, so a frame that arrives
 * before a consumer attaches (the §15.5 handshake, then the op-exchange) is QUEUED, not
 * dropped — a real RTCDataChannel does the same.  Exactly one consumer at a time; a new
 * `consume` replaces the previous one and flushes the queue to it.
 */
class MessageInbox {
  private queue: unknown[] = [];
  private listener: ((data: unknown) => void) | null = null;
  push(data: unknown): void {
    if (this.listener) this.listener(data);
    else this.queue.push(data);
  }
  consume(fn: (data: unknown) => void): void {
    this.listener = fn;
    const pending = this.queue;
    this.queue = [];
    for (const data of pending) fn(data);
  }
}

// --- WebRTC offer/answer/ICE over the sealed signaling transport --------------------

interface EstablishParams {
  readonly p2p: P2pModule;
  readonly pc: RtcPeerConnectionLike;
  readonly rendezvous: import('./rendezvous-client.js').RendezvousTransport;
  readonly channelKey: Uint8Array;
  readonly transportMode: 'relay_only' | 'direct_allowed';
  readonly routing: { roomBlindId: string; senderBlindId: string; recipientBlindId: string };
  readonly selfBlindId: string;
  readonly isOfferer: boolean;
  readonly nowMs: () => number;
  readonly ttlMs: number;
  readonly pollIntervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly throwIfAborted: () => void;
  readonly shouldStop: () => boolean;
  readonly stop: () => void;
}

async function establishDataChannel(
  p: EstablishParams,
): Promise<{ dc: RtcDataChannelLike; inbox: MessageInbox }> {
  const { p2p, pc } = p;
  const inbox = new MessageInbox();
  let remoteDescriptionSet = false;
  const pendingIce: RtcIceCandidateInit[] = [];

  const sendSignal = async (payload: SignalingPayload): Promise<void> => {
    const sealed = await p2p.sealSignal(payload, p.channelKey, {
      roomBlindId: p.routing.roomBlindId,
      senderBlindId: p.routing.senderBlindId,
      recipientBlindId: p.routing.recipientBlindId,
      expiresAt: p.nowMs() + p.ttlMs,
    });
    await p.rendezvous.signal(sealed);
  };

  pc.onicecandidate = (event): void => {
    const line = event.candidate?.candidate;
    if (!line) return; // end-of-candidates
    // §15.4 relay-only IP suppression applied BEFORE a candidate leaves this device.
    const allowed = p2p.filterIceCandidatesForMode(p.transportMode, [line]);
    if (allowed.length === 0) return;
    void sendSignal({
      schema: 'licio.private.signaling_payload.v1',
      kind: 'ice',
      ice_candidate: line,
    });
  };

  // The open data channel resolves this; the offerer creates it, the answerer receives it.
  let resolveChannel!: (dc: RtcDataChannelLike) => void;
  let rejectChannel!: (e: unknown) => void;
  const channelReady = new Promise<RtcDataChannelLike>((resolve, reject) => {
    resolveChannel = resolve;
    rejectChannel = reject;
  });
  const armChannel = (dc: RtcDataChannelLike): void => {
    dc.binaryType = 'arraybuffer';
    // Attach the inbox NOW (before open) so the peer's first frame is never dropped.
    dc.onmessage = (event): void => inbox.push(event.data);
    if (dc.readyState === 'open') {
      resolveChannel(dc);
      return;
    }
    dc.onopen = (): void => resolveChannel(dc);
  };

  if (p.isOfferer) {
    armChannel(pc.createDataChannel('private'));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal({
      schema: 'licio.private.signaling_payload.v1',
      kind: 'offer',
      sdp: offer.sdp ?? '',
    });
  } else {
    pc.ondatachannel = (event): void => armChannel(event.channel);
  }

  const applyPayload = async (payload: SignalingPayload): Promise<void> => {
    if (payload.kind === 'offer' && payload.sdp !== undefined && !p.isOfferer) {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      remoteDescriptionSet = true;
      for (const cand of pendingIce.splice(0)) await pc.addIceCandidate(cand);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal({
        schema: 'licio.private.signaling_payload.v1',
        kind: 'answer',
        sdp: answer.sdp ?? '',
      });
    } else if (payload.kind === 'answer' && payload.sdp !== undefined && p.isOfferer) {
      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      remoteDescriptionSet = true;
      for (const cand of pendingIce.splice(0)) await pc.addIceCandidate(cand);
    } else if (payload.kind === 'ice' && payload.ice_candidate !== undefined) {
      const candidate: RtcIceCandidateInit = { candidate: payload.ice_candidate };
      if (remoteDescriptionSet) await pc.addIceCandidate(candidate);
      else pendingIce.push(candidate); // can't add before the remote description is set
    }
  };

  // Drain queued signals until the channel opens (or we stop / abort / time out).
  const pumpSignals = async (): Promise<void> => {
    while (!p.shouldStop()) {
      try {
        p.throwIfAborted();
      } catch (error) {
        rejectChannel(error);
        return;
      }
      let signals: Awaited<ReturnType<typeof p.rendezvous.signalPoll>>;
      try {
        signals = await p.rendezvous.signalPoll(p.selfBlindId);
      } catch {
        signals = [];
      }
      for (const signal of signals) {
        try {
          await applyPayload(await p2p.openSignal(signal, p.channelKey));
        } catch {
          // A signal we can't open (foreign/tampered) fails closed — skip it.
        }
      }
      if (p.shouldStop()) return;
      await p.sleep(p.pollIntervalMs);
    }
  };
  void pumpSignals();

  try {
    const dc = await channelReady;
    p.stop();
    return { dc, inbox };
  } catch (error) {
    p.stop();
    throw error;
  }
}

// --- §15.5 membership-proving handshake over the open data channel ------------------

interface HandshakeFrame {
  readonly t: 'hello' | 'proof';
  readonly hello?: HandshakeHello;
  readonly sig?: string;
}

interface RunHandshakeParams {
  readonly p2p: P2pModule;
  readonly dc: RtcDataChannelLike;
  readonly inbox: MessageInbox;
  readonly roomIdCommitment: Uint8Array;
  readonly epoch: number;
  readonly selfDeviceId: string;
  readonly selfSigningKey: CryptoKey;
  readonly resolveDevice: DeviceResolver;
  readonly throwIfAborted: () => void;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Runs the §15.5 handshake; resolves to any op frames a faster peer sent during it
 *  (so the caller can hand them to the op-exchange instead of losing them). */
async function runHandshake(p: RunHandshakeParams): Promise<Uint8Array[]> {
  const { p2p, dc } = p;
  const ctx = {
    protocolVersion: HANDSHAKE_VERSION,
    roomIdCommitment: p.roomIdCommitment,
    epoch: p.epoch,
  };

  const ephemeral = await p2p.generateX25519KeyPair();
  const selfHello = p2p.buildHandshakeHello({
    deviceId: p.selfDeviceId,
    ephemeralPublicKey: ephemeral.publicKey,
    helloNonce: p2p.randomBytes(32),
    protocolVersion: HANDSHAKE_VERSION,
  });

  let remoteHello: HandshakeHello | undefined;
  let remoteProofSig: Uint8Array | undefined;
  let proofSent = false;
  let settled = false;
  let resolveDone!: () => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = (): void => {
      settled = true;
      resolve();
    };
    rejectDone = (e: unknown): void => {
      settled = true;
      reject(e);
    };
  });

  const sendSelfProofIfReady = async (): Promise<void> => {
    if (proofSent || !remoteHello) return;
    proofSent = true;
    const sig = await p2p.signHandshakeProof(p.selfSigningKey, selfHello, remoteHello, ctx);
    dc.send(JSON.stringify({ t: 'proof', sig: p2p.toBase64Url(sig) } satisfies HandshakeFrame));
  };

  const tryVerify = async (): Promise<void> => {
    if (!remoteHello || !remoteProofSig) return;
    const resolved = p.resolveDevice(remoteHello.author_device_id);
    const result = await p2p.verifyPeerHandshake({
      localHello: selfHello,
      remoteHello,
      remoteProofSignature: remoteProofSig,
      ctx,
      resolveDevice: (deviceId) => {
        if (!resolved || deviceId !== remoteHello?.author_device_id) return undefined;
        // The key import is async; we resolve it up-front below, so this returns the
        // already-imported key synchronously (verifyPeerHandshake calls it sync).
        return resolvedDevice;
      },
    });
    if (!result.ok) {
      rejectDone(
        new ConnectPrivatePeerError(
          `handshake_${result.reason}`,
          `handshake rejected: ${result.reason}`,
        ),
      );
      return;
    }
    resolveDone();
  };

  // Pre-import the remote device key (verifyPeerHandshake's resolveDevice is sync).
  let resolvedDevice: { publicKey: CryptoKey; activeAtEpoch: boolean } | undefined;
  // Op frames a faster peer sends before our handshake finishes — handed to the channel.
  const opStash: Uint8Array[] = [];

  p.inbox.consume((data): void => {
    if (typeof data !== 'string') {
      opStash.push(toUint8(data as ArrayBuffer | ArrayBufferView)); // not a handshake frame
      return;
    }
    void (async (): Promise<void> => {
      let frame: HandshakeFrame;
      try {
        const parsed: unknown = JSON.parse(data);
        frame = parsed as HandshakeFrame;
      } catch {
        return;
      }
      if (frame.t === 'hello' && frame.hello) {
        remoteHello = frame.hello;
        const resolution = p.resolveDevice(remoteHello.author_device_id);
        if (resolution) {
          try {
            resolvedDevice = {
              publicKey: await p2p.importPublicKeyRaw(
                p2p.fromBase64Url(resolution.signingPublicKey),
              ),
              activeAtEpoch: resolution.activeAtEpoch,
            };
          } catch {
            resolvedDevice = undefined;
          }
        }
        await sendSelfProofIfReady();
        await tryVerify();
      } else if (frame.t === 'proof' && frame.sig) {
        try {
          remoteProofSig = p2p.fromBase64Url(frame.sig);
        } catch {
          return;
        }
        await tryVerify();
      }
    })();
  });

  // Kick off: send our hello immediately.
  dc.send(JSON.stringify({ t: 'hello', hello: selfHello } satisfies HandshakeFrame));

  // Bound the handshake by the overall deadline (stops as soon as it settles).
  void (async (): Promise<void> => {
    while (!settled) {
      try {
        p.throwIfAborted();
      } catch (error) {
        rejectDone(error);
        return;
      }
      await p.sleep(50);
    }
  })();

  await done;
  return opStash; // wrapDataChannel re-consumes the inbox for op frames
}

// --- the post-handshake PeerChannel -------------------------------------------------

function toUint8(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function wrapDataChannel(
  dc: RtcDataChannelLike,
  inbox: MessageInbox,
  opStash: Uint8Array[],
  cleanup: () => void,
): PeerChannel {
  const buffered: Uint8Array[] = [...opStash];
  let listener: ((frame: Uint8Array) => void) | null = null;
  let closeListener: (() => void) | null = null;

  inbox.consume((data): void => {
    if (typeof data === 'string') return; // no string frames post-handshake
    const frame = toUint8(data as ArrayBuffer | ArrayBufferView);
    if (listener) listener(frame);
    else buffered.push(frame); // buffer until the op-exchange attaches its listener
  });
  dc.onclose = (): void => closeListener?.();

  return {
    send(frame: Uint8Array): void {
      // Copy into a standalone ArrayBuffer (the channel must own the bytes).
      const copy = frame.slice();
      dc.send(copy.buffer);
    },
    onMessage(fn: (frame: Uint8Array) => void): void {
      listener = fn;
      for (const frame of buffered.splice(0)) fn(frame);
    },
    onClose(fn: () => void): void {
      closeListener = fn;
    },
    close(): void {
      try {
        dc.close();
      } catch {
        /* already closed */
      }
      cleanup();
    },
  };
}
