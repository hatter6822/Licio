// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Live WebRTC establishment (OFFLINE_SPEC §22.6, §16.3, §19.1, §26.4, WS-R.15.6a/b).
// `connectWebrtc` drives a real `RTCPeerConnection` through offer/answer/ICE over the
// SERVER-BLIND signaling rendezvous and resolves with the opened `RTCDataChannel` (as a
// `DataChannelLike`) that `WebrtcTransport` then wraps.
//
// Doctrine enforced here:
//   * The server is a dumb relay: every SDP and EVERY ICE candidate is AES-256-GCM-sealed
//     (`sealSignal`) before it is POSTed, so the server learns no SDP/ICE/peer-IP (§19.1).
//     A received frame is opened ONLY if its routing (`to`/`room_id_hash`) matches us and
//     its AEAD/AAD verifies — a misrouted or unsealable blob is discarded, never trusted.
//   * relay-only / force-off is APPLIED, not merely decided: a `!allowed` decision refuses
//     to construct a connection at all, and `iceTransportPolicy` from the decision is put
//     onto the real `RTCConfiguration` (so "hide my IP via TURN" actually takes effect).
//   * I/O-agnostic: the HTTP signaling transport is injected (`postSignal`/`pollSignal`),
//     and the `RTCPeerConnection` constructor is injected (`rtcFactory`) so this is unit-
//     testable in Node with a fake peer and exercised against real WebRTC by the gated E2E.

import { TransportUnavailableError } from '@licio/lcap';
import {
  decodeSignalEnvelope,
  decodeSignalMessage,
  encodeSignalEnvelope,
  encodeSignalMessage,
  type WebrtcSignalMessage,
} from './frame.js';
import type { WebrtcDecision } from './ice-policy.js';
import { openSignal, sealSignal } from './signaling.js';
import type { DataChannelLike } from './transport.js';

// --- minimal structural slice of the browser RTC API (so a fake stands in) ----------

export interface RtcSessionDescriptionInit {
  readonly type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  readonly sdp?: string;
}

export interface RtcIceCandidateInit {
  readonly candidate?: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
}

export interface RtcConfigurationLike {
  readonly iceServers?: ReadonlyArray<{
    readonly urls: string | readonly string[];
    readonly username?: string;
    readonly credential?: string;
  }>;
  readonly iceTransportPolicy?: 'all' | 'relay';
}

/** A data channel plus the `onopen` hook `connectWebrtc` waits on. */
export interface ConnectableDataChannel extends DataChannelLike {
  onopen: (() => void) | null;
}

export interface RtcPeerConnectionLike {
  createDataChannel(label: string): ConnectableDataChannel;
  createOffer(): Promise<RtcSessionDescriptionInit>;
  createAnswer(): Promise<RtcSessionDescriptionInit>;
  setLocalDescription(description: RtcSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RtcSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RtcIceCandidateInit): Promise<void>;
  close(): void;
  onicecandidate: ((event: { candidate: RtcIceCandidateInit | null }) => void) | null;
  ondatachannel: ((event: { channel: ConnectableDataChannel }) => void) | null;
}

export type RtcPeerConnectionFactory = (config: RtcConfigurationLike) => RtcPeerConnectionLike;

/** Construct a real browser `RTCPeerConnection` (the default factory). */
function defaultRtcFactory(config: RtcConfigurationLike): RtcPeerConnectionLike {
  // `globalThis.RTCPeerConnection` is typed by the DOM lib as the full browser class,
  // which is not structurally comparable to our minimal `RtcPeerConnectionLike` (readonly
  // array variance), so route the platform-adapter access through `unknown` (the single
  // boundary cast — everything inside `connectWebrtc` uses the structural interfaces).
  const Ctor = (
    globalThis as unknown as {
      RTCPeerConnection?: new (config: RtcConfigurationLike) => RtcPeerConnectionLike;
    }
  ).RTCPeerConnection;
  if (typeof Ctor !== 'function') {
    throw new TransportUnavailableError('webrtc', 'RTCPeerConnection is unavailable');
  }
  return new Ctor(config);
}

export interface ConnectWebrtcParams {
  /** The §26.4 ICE/privacy decision; a `!allowed` decision refuses to connect. */
  readonly decision: WebrtcDecision;
  /** The shared AES-256-GCM signaling key both members hold out of band. */
  readonly signalKey: CryptoKey;
  /** The room rendezvous hash (opaque; never a real room id). */
  readonly roomIdHash: Uint8Array;
  /** This device's opaque peer key. */
  readonly selfPeerKey: string;
  /** The remote device's opaque peer key. */
  readonly remotePeerKey: string;
  /** The initiator creates the offer + data channel; the responder answers. */
  readonly initiator: boolean;
  /** POST a sealed envelope frame to the recipient's mailbox (server-blind). */
  readonly postSignal: (toPeerKey: string, body: Uint8Array) => Promise<void>;
  /** Drain this peer's mailbox, returning sealed envelope frames. */
  readonly pollSignal: (selfPeerKey: string) => Promise<readonly Uint8Array[]>;
  /** Injectable peer-connection constructor (default: global RTCPeerConnection). */
  readonly rtcFactory?: RtcPeerConnectionFactory;
  /** Poll cadence for draining the signaling mailbox (default 250 ms). */
  readonly pollIntervalMs?: number;
  /** Give up if the channel does not open within this long (default 30 s). */
  readonly timeoutMs?: number;
  /** Caller abort. */
  readonly signal?: AbortSignal;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Establish a browser↔browser data channel via the server-blind signaling rendezvous +
 * STUN/TURN, returning the OPEN channel.  Rejects with `TransportUnavailableError` if the
 * decision disallows WebRTC, the channel does not open within `timeoutMs`, or the caller
 * aborts.  The returned channel is handed to `new WebrtcTransport(channel)`.
 */
export async function connectWebrtc(params: ConnectWebrtcParams): Promise<DataChannelLike> {
  if (!params.decision.allowed) {
    throw new TransportUnavailableError(
      'webrtc',
      `webrtc disallowed: ${params.decision.blockedReason || 'unknown'}`,
    );
  }
  const factory = params.rtcFactory ?? defaultRtcFactory;
  const pc = factory({
    iceServers: params.decision.iceServers.map((s) => ({
      urls: s.urls,
      ...(s.username !== undefined ? { username: s.username } : {}),
      ...(s.credential !== undefined ? { credential: s.credential } : {}),
    })),
    iceTransportPolicy: params.decision.iceTransportPolicy,
  });

  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  params.signal?.addEventListener('abort', onCallerAbort, { once: true });

  // Seal + post one signaling message to the peer (server sees only ciphertext).
  const sendSignal = async (message: WebrtcSignalMessage): Promise<void> => {
    const env = await sealSignal({
      roomIdHash: params.roomIdHash,
      from: params.selfPeerKey,
      to: params.remotePeerKey,
      payload: encodeSignalMessage(message),
      key: params.signalKey,
    });
    await params.postSignal(params.remotePeerKey, encodeSignalEnvelope(env));
  };

  // ICE candidates that arrive before the remote description is set must be buffered
  // (addIceCandidate before setRemoteDescription throws).
  let remoteDescriptionSet = false;
  const pendingIce: RtcIceCandidateInit[] = [];
  // Cap the pre-description buffer: a real negotiation needs only a handful, so an ICE-only flood
  // (a peer trickling candidates before the offer/answer lands) cannot grow memory — drop past the
  // cap (ICE retries / the other candidates cover it) (PUB-WEBRTC-6).
  const MAX_PENDING_ICE = 256;
  const addCandidate = async (init: RtcIceCandidateInit): Promise<void> => {
    if (!remoteDescriptionSet) {
      if (pendingIce.length < MAX_PENDING_ICE) pendingIce.push(init);
      return;
    }
    try {
      await pc.addIceCandidate(init);
    } catch {
      // A late/duplicate candidate is non-fatal; ICE proceeds on the others.
    }
  };
  const flushPendingIce = async (): Promise<void> => {
    const queued = pendingIce.splice(0);
    for (const init of queued) {
      try {
        await pc.addIceCandidate(init);
      } catch {
        /* non-fatal */
      }
    }
  };

  // Trickle our local ICE candidates to the peer (each sealed; never logged server-side).
  pc.onicecandidate = (event) => {
    // Once aborted/timed-out the connection is being torn down: a late candidate must NOT
    // continue sealing + POSTing to the relay (that would be metadata egress after the
    // caller gave up).  `pc` stays alive until `pc.close()` in the `finally`, so this guard
    // is what actually stops the trickle.
    if (controller.signal.aborted) return;
    const c = event.candidate;
    if (!c?.candidate) return; // a null/empty candidate marks gathering complete
    void sendSignal({
      kind: 'ice',
      candidate: c.candidate,
      sdp_mid: c.sdpMid ?? null,
      sdp_m_line_index: c.sdpMLineIndex ?? null,
    }).catch(() => {
      /* a dropped trickle is recoverable; other candidates still flow */
    });
  };

  const channelReady = new Promise<DataChannelLike>((resolve, reject) => {
    const armChannel = (channel: ConnectableDataChannel): void => {
      channel.binaryType = 'arraybuffer';
      // The opened channel rides on `pc`, so closing the channel must also close the
      // peer connection — otherwise `WebrtcTransport.close()` (which closes only the
      // channel) would leave the `RTCPeerConnection` + its ICE agent running forever.
      // Rebind `close` to tear both down (idempotent: a second `pc.close()` is a no-op).
      const channelClose = channel.close.bind(channel);
      channel.close = () => {
        channelClose();
        pc.close();
      };
      if (channel.readyState === 'open') {
        resolve(channel);
        return;
      }
      channel.onopen = () => resolve(channel);
    };
    if (params.initiator) {
      armChannel(pc.createDataChannel('lcap'));
    } else {
      pc.ondatachannel = (event) => armChannel(event.channel);
    }
    controller.signal.addEventListener('abort', () => {
      reject(
        new TransportUnavailableError('webrtc', 'connection aborted before the channel opened'),
      );
    });
  });
  // `channelReady` can reject (via the abort listener above) BEFORE it is awaited — e.g. the
  // initiator's offer `sendSignal` fails while offline, throwing before `await channelReady`, so
  // the `finally`'s `controller.abort()` rejects it with no awaiter.  Attach a no-op handler so
  // that rejection is never UNHANDLED; the real `await channelReady` below is a separate consumer
  // that still observes the channel or the rejection.
  void channelReady.catch(() => {});

  const handleMessage = async (message: WebrtcSignalMessage): Promise<void> => {
    if (message.kind === 'offer') {
      if (params.initiator) return; // an initiator never accepts an inbound offer (glare)
      await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      remoteDescriptionSet = true;
      await flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal({ kind: 'answer', sdp: answer.sdp ?? '' });
    } else if (message.kind === 'answer') {
      if (!params.initiator) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      remoteDescriptionSet = true;
      await flushPendingIce();
    } else {
      await addCandidate({
        candidate: message.candidate,
        sdpMid: message.sdp_mid,
        sdpMLineIndex: message.sdp_m_line_index,
      });
    }
  };

  const pollLoop = (async () => {
    const interval = params.pollIntervalMs ?? 250;
    while (!controller.signal.aborted) {
      let frames: readonly Uint8Array[];
      try {
        frames = await params.pollSignal(params.selfPeerKey);
      } catch {
        frames = [];
      }
      for (const frame of frames) {
        let env: ReturnType<typeof decodeSignalEnvelope>;
        try {
          env = decodeSignalEnvelope(frame);
        } catch {
          continue; // garbage frame
        }
        if (env.to !== params.selfPeerKey) continue; // misrouted
        if (env.from !== params.remotePeerKey) continue; // not from the peer we are dialing
        if (!bytesEqual(env.room_id_hash, params.roomIdHash)) continue; // wrong room
        let plaintext: Uint8Array;
        try {
          plaintext = await openSignal(env, params.signalKey); // AEAD/AAD is the trust boundary
        } catch {
          continue; // bad seal — discard, never trust
        }
        let message: WebrtcSignalMessage;
        try {
          message = decodeSignalMessage(plaintext);
        } catch {
          continue;
        }
        try {
          await handleMessage(message);
        } catch {
          // a malformed-but-decodable SDP can reject at the RTC layer; keep polling
        }
      }
      if (controller.signal.aborted) break;
      await delay(interval, controller.signal);
    }
  })();

  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 30_000);
  let opened = false;
  try {
    // The initiator kicks off the offer; the responder waits for it over the poll loop.
    // This runs INSIDE the try so a `createOffer`/`setLocalDescription`/`postSignal`
    // failure still reaches the `finally` (closing `pc`, clearing the timer, stopping the
    // loop) instead of leaking the connection.
    if (params.initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // `createOffer`/`setLocalDescription` can outlast `timeoutMs` (or the caller may abort
      // mid-await); by here `controller` would already be aborted and `channelReady` rejected, so
      // do NOT seal + POST the offer — that would be post-cancel signaling egress that needlessly
      // wakes the remote for a connection this side is tearing down (mirrors the ICE-trickle guard).
      if (!controller.signal.aborted) {
        await sendSignal({ kind: 'offer', sdp: offer.sdp ?? '' });
      }
    }
    const channel = await channelReady;
    opened = true;
    return channel;
  } finally {
    clearTimeout(timer);
    controller.abort(); // stop the poll loop + ICE trickle
    params.signal?.removeEventListener('abort', onCallerAbort);
    void pollLoop.catch(() => {});
    // On any non-success path (timeout, abort, signaling failure) nothing holds the
    // channel, so tear down `pc` here.  On success the returned channel owns `pc` and
    // closes it via the rebound `channel.close()` above.
    if (!opened) pc.close();
  }
}
