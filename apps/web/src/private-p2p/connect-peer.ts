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
import { devWarn } from '../lib/dev-log.js';
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
/** The RTCOfferOptions subset the carrier sets — only `iceRestart` (§15.4 recovery). */
export interface RtcOfferOptionsLike {
  readonly iceRestart?: boolean;
}
export interface RtcPeerConnectionLike {
  createDataChannel(label: string): RtcDataChannelLike;
  createOffer(options?: RtcOfferOptionsLike): Promise<RtcSessionDescriptionInit>;
  createAnswer(): Promise<RtcSessionDescriptionInit>;
  setLocalDescription(description: RtcSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RtcSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RtcIceCandidateInit): Promise<void>;
  onicecandidate: ((event: { candidate: RtcIceCandidateInit | null }) => void) | null;
  ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null;
  /** §15.4 ICE-restart recovery — re-gather ICE on a LIVE connection without re-running the
   *  membership handshake.  Optional: a browser `RTCPeerConnection` has `restartIce()`; when
   *  absent the carrier falls back to an `iceRestart` re-offer.  The connection/ICE-state
   *  fields + change handlers let the carrier observe a transient path failure and recover
   *  the SAME data channel (preserving the §15.5 session key) before it escalates to a hard
   *  drop that forces a full re-dial.  A fake/legacy pc that omits them simply never
   *  ICE-restarts (the watcher stays dormant). */
  restartIce?(): void;
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  onconnectionstatechange?: (() => void) | null;
  oniceconnectionstatechange?: (() => void) | null;
  close(): void;
}
export interface RtcIceServerLike {
  readonly urls: string | string[];
  readonly username?: string;
  readonly credential?: string;
}
/** The RTCConfiguration subset the carrier sets.  `iceTransportPolicy: 'relay'` makes
 *  the browser gather ONLY TURN-relayed candidates (so it never even learns/leaks a
 *  host/srflx IP), the §15.4 relay-only posture — stronger than filtering after the fact. */
export interface RtcConfigLike {
  iceServers?: RtcIceServerLike[];
  iceTransportPolicy?: 'all' | 'relay';
}
export type RtcPeerConnectionFactory = (config: RtcConfigLike) => RtcPeerConnectionLike;

function defaultRtcFactory(config: RtcConfigLike): RtcPeerConnectionLike {
  const Ctor = (
    globalThis as {
      RTCPeerConnection?: new (c: RtcConfigLike) => RtcPeerConnectionLike;
    }
  ).RTCPeerConnection;
  if (!Ctor)
    throw new ConnectPrivatePeerError('rtc_unavailable', 'RTCPeerConnection is unavailable');
  return new Ctor(config);
}

/** Whether any configured ICE server is a TURN relay (`turn:`/`turns:`) — relay-only
 *  mode is non-functional without one (no relay candidate would ever be gathered). */
function hasTurnServer(iceServers: readonly RtcIceServerLike[] | undefined): boolean {
  if (!iceServers) return false;
  return iceServers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => u.startsWith('turn:') || u.startsWith('turns:'));
  });
}

// --- errors -------------------------------------------------------------------------

export type ConnectPrivatePeerReason =
  | 'rtc_unavailable'
  | 'relay_without_turn'
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

/**
 * Tier-2 cap hooks, bound to a device's `RendezvousMember` + the room issuer key by the
 * carrier (the room manager constructs these from the lazily-loaded `rendezvous-cap`
 * subpath). `build` returns the cap (sealed INSIDE the announcement for a member-only verifier
 * AND carried at the top level so the server/relay Tier-2 path can verify it) — or `null` if the
 * device is not enrolled ⇒ Tier-1; `filterVerified` is the §6.8 serverless cap
 * (`filterVerifiedPresence`) over the OPENED capped candidates.  `issuerPubKey` is the per-epoch
 * issuer public key (base64url) the top-level cap carries so a key-less verifier can check it.
 */
export interface RendezvousCapHooks {
  build(
    roomBlindId: string,
    epoch: number,
    bucket: number,
  ): { proof: string; pseudonym: string; issuerPubKey: string } | null;
  /**
   * Verify + DEDUP a batch of opened announcement caps under the room's per-epoch issuer key.
   * Returns the INDICES of `caps` whose proof verifies, deduped by the verified pseudonym
   * (one slot per device per `(epoch, bucket)`) — so a fake-cap flooder is dropped and a
   * device cannot occupy two verified slots, all WITHOUT trusting the relay.
   */
  filterVerified(
    caps: ReadonlyArray<{ proof: string; pseudonym: string }>,
    roomBlindId: string,
    epoch: number,
    bucket: number,
    nowMs: number,
  ): number[];
}

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
  /** §15.6 mesh — device ids to skip in discovery (already-connected peers), so each dial
   *  finds a NEW member rather than re-connecting the first one found. */
  readonly excludePeerDeviceIds?: ReadonlySet<string>;
  /** Tier-2 rendezvous cap hooks (docs/private-p2p/TIER2-RENDEZVOUS-CAP.md §6.8). When
   *  present, the announce embeds a cap from `build`, and the poll SKIPS any opened
   *  announcement whose cap is present-but-INVALID (a fake flood record). A peer with no cap
   *  is treated as Tier-1 — still considered; the §15.5 handshake remains the real auth. */
  readonly rendezvousCap?: RendezvousCapHooks;
  /** §15.4 transport mode (relay-only suppresses IP-revealing ICE candidates). */
  readonly transportMode: 'relay_only' | 'direct_allowed';
  readonly iceServers?: RtcIceServerLike[];
  readonly nowMs: () => number;
  /** Overall connect deadline (default 30s). */
  readonly timeoutMs?: number;
  /** Rendezvous/signal poll interval (default 250ms). */
  readonly pollIntervalMs?: number;
  /** §15.4 — recover a TRANSIENT ICE path failure by ICE-restart on the SAME connection
   *  (preserving the membership-proven session key + the open data channel) instead of a
   *  full re-dial.  Default on; the offerer initiates (the answerer reacts to the re-offer
   *  over the still-live sealed signaling).  A hard drop still falls back to a re-dial. */
  readonly enableIceRestart?: boolean;
  /** How long a `disconnected` ICE state must persist before an ICE-restart is triggered
   *  (a brief blip often self-heals); a `failed` state restarts immediately.  Default 3000ms. */
  readonly iceRestartGraceMs?: number;
  /** Max ICE-restart attempts per failure episode before giving up (→ the channel closes and
   *  `maintainConnection` re-dials); reset once the connection returns to `connected`.
   *  Default 3. */
  readonly maxIceRestarts?: number;
  /** Rendezvous signal-poll cadence once the channel is OPEN — the maintenance loop that
   *  carries ICE-restart renegotiation.  Slower than `pollIntervalMs` so a long-lived
   *  connection does not hammer the rendezvous; the loop polls fast again for a short window
   *  whenever a renegotiation is in flight.  Default 2000ms. */
  readonly maintenancePollMs?: number;
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
export async function connectPrivatePeer(
  params: ConnectPrivatePeerParams,
): Promise<{ channel: PeerChannel; peerDeviceId: string }> {
  const { p2p, rendezvous, roomIdCommitment, epoch, rendezvousKey, selfDeviceId, nowMs } = params;
  const timeoutMs = params.timeoutMs ?? 30_000;
  const pollIntervalMs = params.pollIntervalMs ?? 250;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = nowMs() + timeoutMs;
  const factory = params.rtcFactory ?? defaultRtcFactory;
  const relayOnly = params.transportMode === 'relay_only';
  // §15.4 relay-only is non-functional without a TURN server (filtering the candidates
  // post-gather would yield ZERO candidates → a silent timeout).  Fail FAST + typed.
  if (relayOnly && !hasTurnServer(params.iceServers)) {
    throw new ConnectPrivatePeerError(
      'relay_without_turn',
      'relay-only transport requires a TURN server in iceServers',
    );
  }
  const throwIfAborted = (): void => {
    if (params.signal?.aborted) throw new ConnectPrivatePeerError('aborted', 'connect aborted');
    if (nowMs() >= deadline) throw new ConnectPrivatePeerError('timeout', 'connect timed out');
  };

  const timeBucket = p2p.rendezvousTimeBucket(nowMs());
  const roomBlindId = await p2p.deriveRoomBlindId(rendezvousKey, epoch, timeBucket);

  // 1. Announce our presence with an ephemeral X25519 signaling key. Build the Tier-2 cap FIRST
  //    (if a hook is configured and this device is enrolled): the cap proof is sealed INSIDE the
  //    announcement (a member-only, anti-strip verifier path) AND carried at the TOP LEVEL so the
  //    server/relay Tier-2 path can verify + dedup it WITHOUT the rendezvous key. When capped, the
  //    cap pseudonym IS our peer_blind_id — the §15.3.1 dedup key (one presence slot per device
  //    per (epoch, bucket)); a ZK proof reveals nothing beyond that pseudonym.
  const ephemeral = await p2p.generateX25519KeyPair();
  const cap = params.rendezvousCap?.build(roomBlindId, epoch, timeBucket) ?? undefined;
  const selfPeerBlindId = cap
    ? cap.pseudonym
    : await p2p.derivePeerBlindId(rendezvousKey, selfDeviceId, epoch, timeBucket);
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
        ...(cap ? { cap: { proof: cap.proof, pseudonym: cap.pseudonym } } : {}),
      },
      nowMs: nowMs(),
      ...(cap
        ? {
            cap: {
              proof: cap.proof,
              issuer_pubkey: cap.issuerPubKey,
              epoch: String(epoch),
              bucket: timeBucket,
            },
            capPseudonym: cap.pseudonym,
          }
        : {}),
    }),
  );

  // 2. Discover a peer. Open every candidate announcement (skipping self / unopenable / a
  //    peer we are already connected to), then — Tier-2 — keep only the verified + deduped
  //    capped peers via the §6.8 serverless cap (`filterVerified`), with cap-less peers riding
  //    Tier-1 (the §15.5 handshake remains the membership auth). A fake-cap flooder is dropped
  //    before any dial; nothing here trusts the relay.
  type OpenedAnn = Awaited<ReturnType<typeof p2p.openRendezvousAnnouncement>>;
  type PolledRecord = Awaited<ReturnType<typeof rendezvous.poll>>[number];
  let peer: DiscoveredPeer | undefined;
  while (!peer) {
    throwIfAborted();
    const records = await rendezvous.poll(roomBlindId);
    const opened: { record: PolledRecord; ann: OpenedAnn }[] = [];
    for (const record of records) {
      if (record.peer_blind_id === selfPeerBlindId) continue;
      try {
        const ann = await p2p.openRendezvousAnnouncement(record, rendezvousKey);
        if (ann.peer_device_id === selfDeviceId) continue;
        if (params.excludePeerDeviceIds?.has(ann.peer_device_id)) continue;
        opened.push({ record, ann });
      } catch {
        // A §15.3.2 cover record or a record sealed for a different key: skip it.
      }
    }
    let candidates = opened;
    if (params.rendezvousCap) {
      const capped = opened.filter((o) => o.ann.cap !== undefined);
      const uncapped = opened.filter((o) => o.ann.cap === undefined);
      const survivors = params.rendezvousCap.filterVerified(
        capped.map((o) => o.ann.cap as { proof: string; pseudonym: string }),
        roomBlindId,
        epoch,
        timeBucket,
        nowMs(),
      );
      candidates = [
        ...survivors.map((i) => capped[i] as { record: PolledRecord; ann: OpenedAnn }),
        ...uncapped,
      ];
    }
    const chosen = candidates[0];
    if (chosen) {
      peer = {
        peerBlindId: chosen.record.peer_blind_id,
        peerDeviceId: chosen.ann.peer_device_id,
        peerSignalingPublicKey: p2p.fromBase64Url(chosen.ann.signaling_public_key),
      };
      break;
    }
    await sleep(pollIntervalMs);
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
  const pc = factory({
    ...(params.iceServers ? { iceServers: params.iceServers } : {}),
    // relay-only ⇒ the browser gathers ONLY TURN candidates (never learns/leaks a host IP).
    ...(relayOnly ? { iceTransportPolicy: 'relay' as const } : {}),
  });

  let cleanedUp = false;
  let signalingController: SignalingController | undefined;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    signalingController?.stop(); // halt the maintenance signaling loop
    try {
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
    } catch {
      /* not settable on this pc */
    }
    try {
      pc.close();
    } catch {
      /* already closed */
    }
  };

  try {
    const established = await establishDataChannel({
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
      maintenancePollMs: params.maintenancePollMs ?? 2_000,
      sleep,
      throwIfAborted,
      // Post-open the pump must NOT die at the connect DEADLINE (it carries ICE-restart for
      // the channel's whole lifetime); it ends only on abort or cleanup.
      isAborted: () => params.signal?.aborted === true,
    });
    const { dc, inbox } = established;
    signalingController = established.signaling;

    // 4. §15.5 membership-proving handshake over the open data channel.  Any op frames
    //    a faster peer sends before we finish are stashed (returned) for the channel.
    const { opStash, sessionKey } = await runHandshake({
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

    // 4b. §15.4 ICE-restart recovery (post-handshake).  The sealed signaling channel stays
    //     live, so a TRANSIENT path failure (NAT rebinding, a Wi-Fi↔cellular handover) is
    //     recovered IN PLACE — the offerer re-offers with `iceRestart`, the answerer reacts —
    //     keeping the SAME data channel + the membership-proven session key, never re-running
    //     the handshake.  A `failed` (hard) drop instead closes the channel → `maintainConnection`
    //     re-dials.  The offerer initiates (avoiding offer glare); the answerer only polls fast
    //     on a blip so it applies the re-offer promptly.
    installIceRestartWatcher({
      pc,
      isOfferer,
      signaling: signalingController,
      sleep,
      enabled: params.enableIceRestart ?? true,
      graceMs: params.iceRestartGraceMs ?? 3_000,
      maxRestarts: params.maxIceRestarts ?? 3,
      isCleanedUp: () => cleanedUp,
      // On exhaustion, tear the connection down so the channel's `onclose` fires and
      // `maintainConnection`/`maintainMesh` re-dial — never leak the pump + pc on a
      // `disconnected`-that-never-`failed` path.
      onExhausted: cleanup,
    });

    // 5. Expose the post-handshake channel (binary frames only, each AEAD-sealed under the
    //    §15.5 step-4 session key; the handshake used strings).
    return {
      channel: wrapDataChannel(dc, inbox, opStash, cleanup, p2p, sessionKey),
      peerDeviceId: peer.peerDeviceId,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// --- §15.4 ICE-restart recovery watcher --------------------------------------------

interface IceRestartWatcherParams {
  readonly pc: RtcPeerConnectionLike;
  readonly isOfferer: boolean;
  readonly signaling: SignalingController;
  readonly sleep: (ms: number) => Promise<void>;
  readonly enabled: boolean;
  readonly graceMs: number;
  readonly maxRestarts: number;
  readonly isCleanedUp: () => boolean;
  /** Tear the connection down when ICE-restart attempts are exhausted on a still-failed path,
   *  so the channel's `onclose` fires and the caller re-dials. */
  readonly onExhausted: () => void;
}

/**
 * Observe the live `RTCPeerConnection`'s connection/ICE state and recover a transient path
 * failure by ICE-restart, before it escalates to a hard drop.  Only the OFFERER re-offers
 * (the answerer reacts to the re-offer via the still-live sealed signaling); the answerer
 * still arms the watcher purely to poll the rendezvous fast on a blip.  The recovery is a
 * SELF-DRIVING loop (it re-checks after each attempt rather than waiting for the ICE state to
 * re-fire, which a stuck `disconnected` path may never do): attempts are bounded per episode
 * and reset once the connection returns to `connected`/`completed`; on exhaustion it calls
 * `onExhausted` to tear the connection down so the caller re-dials (never leaving a dead
 * connection — and its signaling pump — to leak).
 */
function installIceRestartWatcher(p: IceRestartWatcherParams): void {
  if (!p.enabled) return;
  const { pc } = p;
  let attempts = 0;
  // A monotonically-increasing token cancelling a pending scheduled re-check when the state
  // changes (e.g. a recovery), so a stale re-check never fires.
  let generation = 0;
  // Whether a recovery chain is currently in flight — prevents concurrent chains; the chain
  // self-drives rather than relying on the ICE state machine to re-fire `disconnected`.
  let recovering = false;

  // The ICE and the connection state machines DIFFER: an ICE-only `disconnected`/`failed` can
  // occur while `connectionState` still reads `connected`, so the restart trigger must see
  // BOTH (reading only `connectionState` would mask the exact signal ICE-restart exists for).
  const iceState = (): string => pc.iceConnectionState ?? '';
  const connState = (): string => pc.connectionState ?? '';
  const isFailed = (): boolean => iceState() === 'failed' || connState() === 'failed';
  const isDisconnected = (): boolean =>
    iceState() === 'disconnected' || connState() === 'disconnected';
  const isRecovered = (): boolean => {
    // A BAD state on EITHER machine takes precedence over a healthy one on the other: an
    // ICE-only `failed`/`disconnected` (while `connectionState` still reads `connected`) is the
    // exact signal ICE-restart exists for, so it must NOT be masked as "recovered" — otherwise
    // `onStateChange` short-circuits and the offerer never re-offers, stranding the live data
    // channel on a dead path.  Recovered ⇔ neither machine is bad AND at least one reads healthy.
    if (isFailed() || isDisconnected()) return false;
    const i = iceState();
    const c = connState();
    return i === 'connected' || i === 'completed' || c === 'connected' || c === 'completed';
  };

  const driveRecovery = (delayMs: number): void => {
    const gen = ++generation;
    void p.sleep(delayMs).then(async () => {
      if (p.isCleanedUp() || gen !== generation || !recovering) return; // superseded / torn down
      if (isRecovered()) {
        recovering = false;
        attempts = 0;
        return;
      }
      if (attempts >= p.maxRestarts) {
        // Exhausted on a still-bad path: hand off to teardown so the caller re-dials.
        recovering = false;
        p.onExhausted();
        return;
      }
      attempts += 1;
      await p.signaling.triggerIceRestart().catch(() => {
        /* a failed re-offer just leaves the path bad; the next re-check escalates */
      });
      // Self-drive the next re-check whether or not the ICE state re-fires `disconnected`.
      if (!p.isCleanedUp() && recovering) driveRecovery(p.graceMs);
    });
  };

  const onStateChange = (): void => {
    if (p.isCleanedUp()) return;
    p.signaling.noteActivity(); // poll the rendezvous fast so a renegotiation completes quickly
    if (isRecovered()) {
      attempts = 0;
      recovering = false;
      generation += 1; // cancel any pending re-check — the path recovered on its own
      return;
    }
    if (!p.isOfferer || recovering) return; // the answerer only fast-polls; one chain at a time
    if (isFailed()) {
      recovering = true;
      driveRecovery(0);
    } else if (isDisconnected()) {
      recovering = true;
      driveRecovery(p.graceMs);
    }
  };

  pc.onconnectionstatechange = onStateChange;
  pc.oniceconnectionstatechange = onStateChange;
  // The watcher is armed only AFTER the data-channel handshake; if the ICE/connection state
  // already reached `disconnected`/`failed` DURING that handshake, the state-change event has
  // already fired and assigning the handlers above will not re-invoke it.  Drive it once now so
  // an already-bad path starts recovery (or tears down) immediately instead of waiting for the
  // next transition — which a stuck `disconnected` path may never deliver.
  onStateChange();
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
  /** Slow signal-poll cadence once the channel is open (the maintenance loop). */
  readonly maintenancePollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Deadline-bounded abort, used PRE-open only (a stuck dial must time out). */
  readonly throwIfAborted: () => void;
  /** Abort-signal-only check, used POST-open (the maintenance loop must outlive the
   *  connect deadline — it ends only on an explicit abort or `signaling.stop()`). */
  readonly isAborted: () => boolean;
}

/** Controls the long-lived sealed-signaling loop after the channel is open. */
interface SignalingController {
  /** Offerer-only: re-negotiate ICE on the live connection via an `iceRestart` re-offer
   *  (and `pc.restartIce()` when available) — the data channel + session key survive. */
  triggerIceRestart(): Promise<void>;
  /** Poll the rendezvous fast for a short window (so a renegotiation completes promptly). */
  noteActivity(): void;
  /** Stop the maintenance loop (called by `cleanup`). */
  stop(): void;
}

/** While a renegotiation is in flight, poll the rendezvous at the fast cadence for this long. */
const FAST_POLL_WINDOW_MS = 15_000;

async function establishDataChannel(
  p: EstablishParams,
): Promise<{ dc: RtcDataChannelLike; inbox: MessageInbox; signaling: SignalingController }> {
  const { p2p, pc } = p;
  const inbox = new MessageInbox();
  let remoteDescriptionSet = false;
  const pendingIce: RtcIceCandidateInit[] = [];
  let stopped = false;
  let channelOpen = false;
  // Poll fast (pollIntervalMs) until nowMs() >= fastUntil, then drop to maintenancePollMs.
  // Seeded so the whole establishment + the first window after open polls fast.
  let fastUntil = p.nowMs() + FAST_POLL_WINDOW_MS;
  const noteActivity = (): void => {
    fastUntil = p.nowMs() + FAST_POLL_WINDOW_MS;
  };

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
    const cand = event.candidate;
    const line = cand?.candidate;
    if (!line) return; // end-of-candidates
    // §15.4 relay-only IP suppression applied BEFORE a candidate leaves this device.
    const allowed = p2p.filterIceCandidatesForMode(p.transportMode, [line]);
    if (allowed.length === 0) return;
    // Carry sdpMid/sdpMLineIndex: a real addIceCandidate rejects a candidate with neither
    // (the line alone does not identify the m-line), silently dropping every candidate.
    void sendSignal({
      schema: 'licio.private.signaling_payload.v1',
      kind: 'ice',
      ice_candidate: line,
      sdp_mid: cand?.sdpMid ?? null,
      sdp_mline_index: cand?.sdpMLineIndex ?? null,
    });
  };

  // The open data channel resolves this; the offerer creates it, the answerer receives it.
  let resolveChannel!: (dc: RtcDataChannelLike) => void;
  let rejectChannel!: (e: unknown) => void;
  const channelReady = new Promise<RtcDataChannelLike>((resolve, reject) => {
    resolveChannel = resolve;
    rejectChannel = reject;
  });
  const markOpen = (dc: RtcDataChannelLike): void => {
    channelOpen = true;
    resolveChannel(dc);
  };
  const armChannel = (dc: RtcDataChannelLike): void => {
    dc.binaryType = 'arraybuffer';
    // Attach the inbox NOW (before open) so the peer's first frame is never dropped.
    dc.onmessage = (event): void => inbox.push(event.data);
    if (dc.readyState === 'open') {
      markOpen(dc);
      return;
    }
    dc.onopen = (): void => markOpen(dc);
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
    // Any inbound signaling may be a renegotiation (an ICE-restart re-offer/answer) — keep
    // polling fast so the round-trip completes promptly before the cadence drops to slow.
    noteActivity();
    if (payload.kind === 'offer' && payload.sdp !== undefined && !p.isOfferer) {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      remoteDescriptionSet = true;
      for (const cand of pendingIce.splice(0)) {
        try {
          await pc.addIceCandidate(cand);
        } catch (error) {
          // A buffered candidate that STILL can't attach to the freshly-applied description is
          // unexpected (it should have matched) — report it (the helper logs no candidate data:
          // it can carry an IP) and drop it as genuinely stale rather than swallowing it silently.
          devWarn('ICE candidate did not apply after renegotiation', error);
        }
      }
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
      for (const cand of pendingIce.splice(0)) {
        try {
          await pc.addIceCandidate(cand);
        } catch (error) {
          // A buffered candidate that STILL can't attach to the freshly-applied description is
          // unexpected (it should have matched) — report it (the helper logs no candidate data:
          // it can carry an IP) and drop it as genuinely stale rather than swallowing it silently.
          devWarn('ICE candidate did not apply after renegotiation', error);
        }
      }
    } else if (payload.kind === 'ice' && payload.ice_candidate !== undefined) {
      const candidate: RtcIceCandidateInit = {
        candidate: payload.ice_candidate,
        sdpMid: payload.sdp_mid ?? null,
        sdpMLineIndex: payload.sdp_mline_index ?? null,
      };
      if (remoteDescriptionSet) {
        try {
          await pc.addIceCandidate(candidate);
        } catch {
          // The candidate outran its (re-)offer: an ICE-restart re-offer's candidates can be
          // signalled before the re-offer itself, and `remoteDescriptionSet` stays latched true
          // from the initial negotiation — so they can't attach to the current description.  Buffer
          // them (as the initial negotiation does via the else-branch) to retry after the next
          // setRemoteDescription, instead of dropping them and stranding the restart.
          pendingIce.push(candidate);
        }
      } else {
        pendingIce.push(candidate); // can't add before the remote description is set
      }
    }
  };

  // §15.4 offerer-only ICE-restart: re-gather ICE on the LIVE connection (the data channel +
  // session key survive).  `restartIce()` (when the pc exposes it) re-gathers without a manual
  // re-offer, but we ALSO send an `iceRestart` re-offer so the answerer renegotiates — both
  // peers must agree, and `restartIce()` alone does not generate the SDP the answerer needs.
  const triggerIceRestart = async (): Promise<void> => {
    if (stopped || !p.isOfferer) return;
    noteActivity();
    if (typeof pc.restartIce === 'function') {
      try {
        pc.restartIce();
      } catch {
        /* fall through to the re-offer, which is sufficient on its own */
      }
    }
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await sendSignal({
      schema: 'licio.private.signaling_payload.v1',
      kind: 'offer',
      sdp: offer.sdp ?? '',
    });
  };

  // Drain queued signals.  PRE-open the loop is bounded by the connect deadline (a stuck dial
  // must time out → reject).  POST-open it is the long-lived MAINTENANCE loop carrying any
  // ICE-restart renegotiation: it outlives the connect deadline and ends only on abort or
  // `stop()`, polling at the slow cadence when quiescent and the fast cadence in a renegotiation
  // window (so a recovery completes quickly without hammering the rendezvous when idle).
  const pumpSignals = async (): Promise<void> => {
    while (!stopped) {
      if (channelOpen) {
        if (p.isAborted()) {
          stopped = true;
          return;
        }
      } else {
        try {
          p.throwIfAborted();
        } catch (error) {
          rejectChannel(error);
          return;
        }
      }
      let signals: Awaited<ReturnType<typeof p.rendezvous.signalPoll>>;
      try {
        signals = await p.rendezvous.signalPoll(p.selfBlindId);
      } catch (error) {
        signals = []; // a transient poll failure → retry next loop, but surface it in dev
        devWarn('rendezvous signal poll failed', error);
      }
      for (const signal of signals) {
        try {
          await applyPayload(await p2p.openSignal(signal, p.channelKey));
        } catch (error) {
          // A signal we can't open (foreign/tampered) fails closed — skip it, but surface it in
          // dev: a persistent failure here is a real bug (bad key/codec), not just a probe.
          devWarn('skipped a signal that failed to open or apply', error);
        }
      }
      if (stopped) return;
      const cadence =
        channelOpen && p.nowMs() >= fastUntil ? p.maintenancePollMs : p.pollIntervalMs;
      await p.sleep(cadence);
    }
  };
  void pumpSignals();

  const signaling: SignalingController = {
    triggerIceRestart,
    noteActivity,
    stop: () => {
      stopped = true;
    },
  };

  try {
    const dc = await channelReady;
    // Do NOT stop the pump — it carries ICE-restart renegotiation for the channel's lifetime.
    return { dc, inbox, signaling };
  } catch (error) {
    stopped = true; // establishment failed → halt the pump
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
async function runHandshake(
  p: RunHandshakeParams,
): Promise<{ opStash: Uint8Array[]; sessionKey: Uint8Array }> {
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
  // §15.5 step 4 — the pairwise data-channel session key, derived from the handshake
  // ephemeral ECDH + transcript once the remote device is verified (set before
  // resolveDone, so it is defined whenever `done` resolves).
  let sessionKey: Uint8Array | undefined;
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
    // §15.5 step 4 — derive the epoch-bound pairwise session key from the handshake
    // ephemeral ECDH + the (canonicalized) transcript; post-handshake op frames are
    // additionally AEAD-sealed under it (defence in depth over per-op AEAD + DTLS, and
    // it hides the sync metadata from a DTLS-terminating relay).  Both peers derive the
    // SAME key (the transcript sorts the ephemeral keys).
    sessionKey = await p2p.deriveHandshakeSessionKey(
      ephemeral.privateKey,
      p2p.fromBase64Url(remoteHello.ephemeral_public_key),
      selfHello,
      remoteHello,
      ctx,
    );
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
      } catch (error) {
        devWarn('dropped a non-JSON handshake frame', error);
        return;
      }
      if (frame.t === 'hello' && frame.hello) {
        // Validate the inbound hello FAIL-FAST: a malformed hello (e.g. a regex-passing
        // but non-base64url ephemeral key) would otherwise throw later inside
        // signHandshakeProof and hang the connect to the deadline. Reject promptly +
        // typed, symmetric with verifyPeerHandshake's own hardening.
        const parsedHello = p2p.handshakeHelloSchema.safeParse(frame.hello);
        if (!parsedHello.success) {
          rejectDone(
            new ConnectPrivatePeerError('handshake_malformed_hello', 'malformed remote hello'),
          );
          return;
        }
        remoteHello = parsedHello.data;
        const resolution = p.resolveDevice(remoteHello.author_device_id);
        if (resolution) {
          try {
            resolvedDevice = {
              publicKey: await p2p.importPublicKeyRaw(
                p2p.fromBase64Url(resolution.signingPublicKey),
              ),
              activeAtEpoch: resolution.activeAtEpoch,
            };
          } catch (error) {
            resolvedDevice = undefined;
            devWarn('could not import the resolved device public key', error);
          }
        }
        await sendSelfProofIfReady();
        await tryVerify();
      } else if (frame.t === 'proof' && frame.sig) {
        try {
          remoteProofSig = p2p.fromBase64Url(frame.sig);
        } catch (error) {
          devWarn('dropped a malformed handshake proof signature', error);
          return;
        }
        await tryVerify();
      }
    })().catch((error) => rejectDone(error)); // a thrown error fails fast, not via timeout
  });

  // A data-channel close DURING the handshake fails the connect immediately (otherwise it
  // would hang until the deadline); wrapDataChannel re-points onclose post-handshake.
  p.dc.onclose = (): void => {
    rejectDone(
      new ConnectPrivatePeerError('handshake_channel_closed', 'data channel closed mid-handshake'),
    );
  };

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
  if (!sessionKey)
    throw new ConnectPrivatePeerError(
      'handshake_no_session_key',
      'handshake settled without a session key',
    );
  return { opStash, sessionKey }; // wrapDataChannel re-consumes the inbox for op frames
}

// --- the post-handshake PeerChannel -------------------------------------------------

function toUint8(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** The AEAD AAD binding a post-handshake op frame's purpose under the session key
 *  (§15.5 step 4); a frame sealed for another purpose/context cannot open here. */
const OP_FRAME_AAD = new TextEncoder().encode('licio.private.op-frame.v1');

function wrapDataChannel(
  dc: RtcDataChannelLike,
  inbox: MessageInbox,
  opStash: Uint8Array[],
  cleanup: () => void,
  p2p: ConnectPrivatePeerParams['p2p'],
  sessionKey: Uint8Array,
): PeerChannel {
  const buffered: Uint8Array[] = [];
  let listener: ((frame: Uint8Array) => void) | null = null;
  let closeListener: (() => void) | null = null;

  // Open a sealed frame under the §15.5 step-4 session key, then deliver the plaintext.
  // A frame that does not open (tampered, or not sealed by the session-key holder) is
  // DROPPED fail-closed — a DTLS-terminating relay cannot inject or read op frames.
  const deliver = (sealed: Uint8Array): void => {
    void p2p
      .aeadOpen(sessionKey, sealed, OP_FRAME_AAD)
      .then((frame) => {
        if (listener) listener(frame);
        else buffered.push(frame);
      })
      .catch(() => {
        /* not openable under the session key → drop (fail-closed) */
      });
  };

  // The op frames a faster peer sent during our handshake are ALSO sealed (it sealed them
  // after ITS handshake) — open them under the same session key.
  for (const sealed of opStash) deliver(sealed);
  inbox.consume((data): void => {
    if (typeof data === 'string') return; // no string frames post-handshake
    deliver(toUint8(data as ArrayBuffer | ArrayBufferView));
  });
  // A remote drop (the data channel closes underneath us) both notifies the session AND runs
  // cleanup — closing the pc + halting the long-lived maintenance signaling loop so it does
  // not leak past the connection.  An in-place ICE-restart does NOT close the data channel
  // (the SCTP/DTLS association survives), so this fires only on a genuine, unrecoverable drop;
  // the session's onClose then drives `maintainConnection` to re-dial.
  dc.onclose = (): void => {
    closeListener?.();
    cleanup();
  };

  return {
    async send(frame: Uint8Array): Promise<void> {
      const sealed = await p2p.aeadSeal(sessionKey, frame, OP_FRAME_AAD);
      // Copy into a standalone ArrayBuffer (the channel must own the bytes).
      dc.send(sealed.slice().buffer);
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
