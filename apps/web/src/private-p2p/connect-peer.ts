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
  /** SCTP send-buffer backpressure (present on a real RTCDataChannel; a fake may omit it — the
   *  carrier then sends without waiting).  Used to pause fragment sends before the buffer overruns. */
  bufferedAmount?: number;
  bufferedAmountLowThreshold?: number;
  onbufferedamountlow?: (() => void) | null;
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
  | 'peer_device_id_mismatch'
  | 'candidate_dial_timeout'
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
 * Tier-2 cap hooks, bound to a device's `RendezvousMember` + the room issuer key by the carrier
 * (the room manager constructs these from the lazily-loaded `rendezvous-cap` subpath).  `build`
 * returns the cap to seal INSIDE the announcement (member-only verification — there is NO top-level,
 * server-visible cap; PRIV-API-RENDEZVOUS-1), or `null` if the device is not enrolled ⇒ Tier-1;
 * `filterVerified` is the §6.8 serverless cap (`filterVerifiedPresence`) over the OPENED capped
 * candidates (defensive-decoded + per-poll-bounded against a flood, PR3b).
 */
export interface RendezvousCapHooks {
  /**
   * The cap is BOUND to the announcement's DIAL-CRITICAL fields — the ephemeral
   * signalling key AND the device id it claims — so a cap lifted out of a polled
   * announcement cannot be re-published under someone else's dial info, which,
   * because dedup is by pseudonym with first occurrence winning, would evict the
   * honest device from discovery.
   *
   * Binding the signalling key alone was not enough: a hostile member could keep
   * the honest key (so the proof still verified), swap `peerDeviceId`, and
   * re-seal with a later expiry.  `selectFreshestCandidates` dedups by that key
   * BEFORE cap verification, so the forgery replaced the honest record and the
   * dial reached the honest peer, failed the §15.5 claimed-device check, and
   * cooled its key down.
   */
  build(
    roomBlindId: string,
    epoch: number,
    bucket: number,
    signalingPublicKey: Uint8Array,
    peerDeviceId: string,
  ): { proof: string; pseudonym: string } | null;
  /**
   * Verify + DEDUP a batch of opened announcement caps under the room's per-epoch issuer key.
   * Returns the INDICES of `caps` whose proof verifies, deduped by the verified pseudonym
   * (one slot per device per `(epoch, bucket)`) — so a fake-cap flooder is dropped and a
   * device cannot occupy two verified slots, all WITHOUT trusting the relay.  Undecodable caps are
   * SKIPPED (never crash the batch) and the per-poll verify count is bounded (PR3b).
   */
  filterVerified(
    /** Each cap WITH the dial identity of the announcement it came from — the proof is
     *  verified against that key, never one the caller picks. */
    caps: ReadonlyArray<{
      proof: string;
      pseudonym: string;
      signalingPublicKey: Uint8Array;
      peerDeviceId: string;
    }>,
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
  /** Per-CANDIDATE dial+handshake deadline (PRIV-CARRIER-3): a single stale/stuck candidate cannot
   *  consume the whole `timeoutMs` budget — it is abandoned after this so the NEXT discovered
   *  candidate is tried.  Bounded by the overall deadline.  Default 12000ms. */
  readonly candidateDialTimeoutMs?: number;
  /** How long a candidate that FAILED to dial this connect is skipped before being retried, so a
   *  re-poll does not immediately re-pick a known-bad peer (PRIV-CARRIER-3).  Default 15000ms. */
  readonly failedPeerCooldownMs?: number;
  readonly rtcFactory?: RtcPeerConnectionFactory;
  readonly signal?: AbortSignal;
  /** A sleep primitive (injectable so tests can pump a fake clock). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const SIGNAL_TTL_MS = 5 * 60_000;
// The §15.4 signaling-channel KDF transcript version, DELIBERATELY DECOUPLED from the wire
// `HANDSHAKE_PROTOCOL_VERSION`.  The signaling layer (X25519-ECDH + AES-GCM sealing of SDP/ICE)
// has not changed, so a wire-version bump must NOT change this transcript — otherwise two peers
// on different builds would derive different signaling keys, `openSignal` would drop every
// offer/answer, and the connect would burn the full timeout instead of reaching the fast, typed
// `protocol_version_mismatch` at the handshake.  Keeping it stable lets the data channel ALWAYS
// establish across a version skew so the handshake (which DOES bind the wire version) rejects an
// incompatible peer promptly.  Bump this only if the signaling protocol itself changes.
const SIGNALING_TRANSCRIPT_VERSION = 1;

interface DiscoveredPeer {
  readonly peerBlindId: string;
  readonly peerDeviceId: string;
  readonly peerSignalingPublicKey: Uint8Array;
}

/**
 * Reduce the opened rendezvous candidates to the set worth dialing, freshest-first.
 *
 * A peer re-announces a FRESH ephemeral each dial while its PRIOR announcements linger under TTL, so
 * `opened` can hold several records for ONE device (stale + current), and dialing a STALE one first
 * burns a candidate deadline on a dead/already-resolved channel before the peer's live dial is ever
 * reached (PRIV-CARRIER-FRESHEST).  So dedup on the ACTUAL dialed identity — the per-announcement
 * EPHEMERAL `signaling_public_key` — and NOT the claimed `peer_device_id`: that field is
 * UNAUTHENTICATED here (the announcement is sealed under the room-wide rendezvous key, so any
 * current-epoch member can seal one claiming ANOTHER device's id — exactly what the §15.5 handshake
 * mismatch check re-verifies).  Keying the dedup on the claimed device id would let a spoof sealed with
 * a LATER `expires_at` EVICT the honest device's DISTINCT candidate before it is ever dialed, so
 * repeated polls keep selecting only the spoof and the targeted peer stays unreachable — a persistent
 * targeted DoS (PRIV-CARRIER-FRESHEST-NOSPOOF).  Keying on the ephemeral only merges a genuine
 * re-announcement of the SAME dial (keep the fresher record); two DISTINCT ephemerals — one device's
 * stale-vs-current OR an honest live dial vs. a spoof under the same claimed id — are ALWAYS kept as
 * separate candidates, then sorted freshest-first so the live dial is reached before any stale one
 * WITHOUT an unproven id ever dropping an honest candidate (the spoof, being newer, is dialed first,
 * where the §15.5 mismatch check rejects it + the ephemeral-keyed cooldown suppresses it, and the
 * honest candidate is dialed in the SAME round).  Flood amplification stays bounded by the orthogonal
 * Tier-2 cap + Tier-1 sample-poll, never by this dedup.
 */
export function selectFreshestCandidates<
  C extends { record: { expires_at: number }; ann: { signaling_public_key: string } },
>(opened: readonly C[]): C[] {
  const freshestByEphemeral = new Map<string, C>();
  for (const c of opened) {
    const prev = freshestByEphemeral.get(c.ann.signaling_public_key);
    if (prev === undefined || c.record.expires_at > prev.record.expires_at) {
      freshestByEphemeral.set(c.ann.signaling_public_key, c);
    }
  }
  return [...freshestByEphemeral.values()].sort(
    (a, b) => b.record.expires_at - a.record.expires_at,
  );
}

/**
 * Which candidate this round dials, given the freshest-first sample.
 *
 * FRESHEST-FIRST ALONE IS STARVABLE.  A hostile member can mint a fresh
 * announcement whenever it likes: the cooldown that suppresses a failed dial is
 * keyed by the record's ephemeral key, so rotating that key puts a NEW spoof at
 * the head of every re-polled sample, and `triable[0]` hands it every dial
 * attempt until the overall deadline expires.  The honest peer, sitting behind
 * it, is never reached — and the old drain-the-whole-list loop, for all its
 * live-lock cost, at least got there eventually.
 *
 * ALTERNATE: even rounds take the freshest (the fast path, and the ordering the
 * §15.5 mismatch check + cooldown are designed around); odd rounds take the
 * most starved — the OLDEST untried candidate, which is where an honest,
 * non-rotating announcement settles as spoofs pile up in front of it.  A
 * flooder can therefore occupy at most every OTHER dial no matter how fast it
 * mints records, so an honest candidate is reached within two rounds of
 * becoming triable, and the cost stays one dial per round rather than
 * `candidates × deadline`.
 */
export function pickDialCandidate<C>(triable: readonly C[], round: number): C | undefined {
  if (triable.length === 0) return undefined;
  return round % 2 === 0 ? triable[0] : triable[triable.length - 1];
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
  const candidateDialTimeoutMs = params.candidateDialTimeoutMs ?? 12_000;
  const failedPeerCooldownMs = params.failedPeerCooldownMs ?? 15_000;
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
  //    announcement ONLY (a member-only verifier path; there is NO top-level, server-visible cap —
  //    PRIV-API-RENDEZVOUS-1: a server-held per-(room, epoch) issuer key would be a stable cross-bucket
  //    linking handle that breaks §15.3 unlinkability, so the server never verifies the cap and runs
  //    the §27 Tier-1 sample-poll).  The cap's BBS `pseudonym` is DISTINCT from `peer_blind_id` (the
  //    latter is the HMAC-derived per-(device, epoch, bucket) id); a polling MEMBER opens the sealed
  //    cap and dedups by the verified pseudonym.
  // ONE signalling identity per (room, epoch, time bucket), derived DETERMINISTICALLY from this
  // device's own signing key rather than freshly generated per call.  A mesh member runs `connectPrivatePeer` CONCURRENTLY, once per
  // peer, so a fresh-per-call ephemeral gave a device several live dial identities at once — and a
  // polling peer took whichever announcement was freshest, which belonged to the call dialling
  // SOMEONE ELSE.  That call's pump then failed to open the offer (a channel key for a different
  // peer), and a handshake completed only when both sides happened to pick the announcements of the
  // calls dialling each other.  One identity removes the coincidence instead of narrowing it; see
  // `deriveSignalingKeyPair`.
  const ephemeral = await p2p.deriveSignalingKeyPair(
    // A DEVICE secret, not the room's.  Deriving this scalar from the rendezvous
    // key made it computable by every member — see `deriveSignalingKeyPair`.
    params.selfSigningKey,
    roomIdCommitment,
    selfDeviceId,
    epoch,
    timeBucket,
  );
  // The per-announcer cap rides SEALED INSIDE the announcement only (PRIV-API-RENDEZVOUS-1: the
  // server-visible top-level cap was removed because the server-held issuer key is a cross-bucket
  // linking handle).  A member-only verifier opens it from the polled announcement and
  // `filterVerified`s by the verified pseudonym; the server sees only the per-device derived blind id
  // (one slot per device per bucket) and runs the §27 Tier-1 sample-poll.
  const cap =
    params.rendezvousCap?.build(
      roomBlindId,
      epoch,
      timeBucket,
      ephemeral.publicKey,
      selfDeviceId,
    ) ?? undefined;
  const selfPeerBlindId = await p2p.derivePeerBlindId(
    rendezvousKey,
    selfDeviceId,
    epoch,
    timeBucket,
  );
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
        // SEALED-inside cap (member-only) — the peer-side anti-flood input.
        ...(cap ? { cap: { proof: cap.proof, pseudonym: cap.pseudonym } } : {}),
      },
      nowMs: nowMs(),
    }),
  );

  // 2. Discover a peer. Open every candidate announcement (skipping self / unopenable / a
  //    peer we are already connected to), then — Tier-2 — keep only the verified + deduped
  //    capped peers via the §6.8 serverless cap (`filterVerified`), with cap-less peers riding
  //    Tier-1 (the §15.5 handshake remains the membership auth). A fake-cap flooder is dropped
  //    before any dial; nothing here trusts the relay.
  type OpenedAnn = Awaited<ReturnType<typeof p2p.openRendezvousAnnouncement>>;
  type PolledRecord = Awaited<ReturnType<typeof rendezvous.poll>>[number];
  type Candidate = { record: PolledRecord; ann: OpenedAnn };

  // Dial ONE discovered candidate to a live, membership-proven channel.  Resolves to the channel on
  // success; on ANY failure it tears down its OWN pc + signaling loop and throws (the caller cools
  // the peer down + tries the next candidate).  A per-CANDIDATE deadline bounds a stale/stuck peer so
  // it cannot consume the whole connect budget; AFTER the handshake the live connection is governed by
  // `params.signal` alone (this candidate deadline no longer applies).
  const dialCandidate = async (
    peer: DiscoveredPeer,
  ): Promise<{ channel: PeerChannel; peerDeviceId: string }> => {
    // 3. Derive the pairwise signaling channel key (transcript-bound; both peers agree).  This uses
    //    the STABLE signaling-transcript version, NOT the wire `HANDSHAKE_PROTOCOL_VERSION`, so a
    //    version-skewed peer can still exchange SDP/ICE and open the channel — the wire-version check
    //    is the handshake's job (it fails fast + typed rather than timing out the signaling).
    const channelKey = await p2p.deriveChannelKey(
      ephemeral.privateKey,
      peer.peerSignalingPublicKey,
      {
        protocolVersion: SIGNALING_TRANSCRIPT_VERSION,
        roomIdCommitment,
        epoch,
        ephemeralPublicKeyA: ephemeral.publicKey,
        ephemeralPublicKeyB: peer.peerSignalingPublicKey,
      },
      p2p.CHANNEL_LABEL_SIGNALING,
    );

    // PAIRWISE, DIRECTED §15.4 signaling addresses.  The signal drain is deliver-once, so two live
    // sessions on one device must never share an inbound address — the first pump to poll would
    // consume, and drop as un-openable, a signal meant for the other session's channel.  A per-CALL
    // ephemeral used to provide that separation; now that a device has ONE identity per bucket, the
    // SENDER's key is what separates its sessions, so the address is keyed on both.  Directed
    // (sender first) so A→B and B→A are distinct queues and a peer never drains its own signal.
    //
    // The cost is that this can only be derived AFTER discovering the peer, so draining starts one
    // poll later than the old self-only address allowed.  Nothing is lost: the queue is a TTL'd
    // server-side mailbox, not a live socket, and an offer sent before the answerer began draining
    // is still waiting when it does — the property ICE candidates arriving ahead of their offer
    // already depend on.
    const selfSignalAddr = await p2p.deriveSignalAddress(
      rendezvousKey,
      peer.peerSignalingPublicKey,
      ephemeral.publicKey,
      epoch,
      timeBucket,
    );
    const peerSignalAddr = await p2p.deriveSignalAddress(
      rendezvousKey,
      ephemeral.publicKey,
      peer.peerSignalingPublicKey,
      epoch,
      timeBucket,
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
    // The session's close-notification (wrapDataChannel's `handleClose`), registered once the channel
    // is exposed.  cleanup() fires it DIRECTLY (PRIV-CARRIER-TEARDOWN) rather than relying on
    // pc.close() to fire dc.onclose — the W3C spec does NOT dispatch a `close` event on a data channel
    // whose OWNING connection is closed by close(), so on a real browser an ICE-restart exhaustion /
    // answerer give-up teardown would otherwise never notify the session (no re-dial, leaked session +
    // mesh slot).  Null before the channel is exposed (a pre-handshake failure rejects the connect
    // instead), so the `?.()` is a no-op then.
    const closeNotifier: { fire: (() => void) | null } = { fire: null };
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
      // DETERMINISTICALLY notify the session of the drop (idempotent via handleClose's own guard), so
      // maintainConnection/maintainMesh re-dial + prune even when pc.close() does not fire dc.onclose.
      closeNotifier.fire?.();
    };

    // The per-candidate deadline applies to the dial + handshake ONLY (never the live connection), and
    // never exceeds the overall connect deadline.
    const candidateDeadline = Math.min(deadline, nowMs() + candidateDialTimeoutMs);
    const dialThrowIfAborted = (): void => {
      if (params.signal?.aborted) throw new ConnectPrivatePeerError('aborted', 'connect aborted');
      if (nowMs() >= deadline) throw new ConnectPrivatePeerError('timeout', 'connect timed out');
      if (nowMs() >= candidateDeadline) {
        throw new ConnectPrivatePeerError(
          'candidate_dial_timeout',
          'dial to a candidate timed out (trying the next)',
        );
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
          senderBlindId: selfSignalAddr,
          recipientBlindId: peerSignalAddr,
        },
        selfBlindId: selfSignalAddr,
        isOfferer,
        nowMs,
        ttlMs: SIGNAL_TTL_MS,
        pollIntervalMs,
        maintenancePollMs: params.maintenancePollMs ?? 2_000,
        sleep,
        // The dial + handshake honor the PER-CANDIDATE deadline so a stuck candidate is abandoned…
        throwIfAborted: dialThrowIfAborted,
        // …but the POST-open maintenance loop (ICE-restart for the channel's whole lifetime) lives on
        // the OUTER abort only, NOT this candidate deadline.
        isAborted: () => params.signal?.aborted === true,
      });
      const { dc, inbox } = established;
      signalingController = established.signaling;

      // 4. §15.5 membership-proving handshake over the open data channel.  Any op frames a faster
      //    peer sends before we finish are stashed (returned) for the channel.
      const {
        opStash,
        sessionKey,
        peerDeviceId: provenPeerDeviceId,
      } = await runHandshake({
        p2p,
        dc,
        inbox,
        roomIdCommitment,
        epoch,
        selfDeviceId,
        selfSigningKey: params.selfSigningKey,
        resolveDevice: params.resolveDevice,
        throwIfAborted: dialThrowIfAborted,
        sleep,
      });
      // The rendezvous announcement's `peer_device_id` is UNAUTHENTICATED (sealed under the room-wide
      // rendezvous key, so any current-epoch member can claim any id).  If it does not match the
      // §15.5 handshake-PROVEN device id, the dialed peer lied about who it is — refuse the connection
      // rather than attributing the channel to a spoofed id.
      if (peer.peerDeviceId !== provenPeerDeviceId) {
        throw new ConnectPrivatePeerError(
          'peer_device_id_mismatch',
          'rendezvous-claimed device id does not match the handshake-proven device id',
        );
      }

      // 4b. §15.4 ICE-restart recovery (post-handshake).  The sealed signaling channel stays live, so
      //     a TRANSIENT path failure (NAT rebinding, a Wi-Fi↔cellular handover) is recovered IN PLACE
      //     — the offerer re-offers with `iceRestart`, the answerer reacts — keeping the SAME data
      //     channel + the membership-proven session key, never re-running the handshake.  A `failed`
      //     (hard) drop instead closes the channel → `maintainConnection` re-dials.  The offerer
      //     initiates (avoiding offer glare); the answerer only polls fast on a blip so it applies the
      //     re-offer promptly.
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

      // 5. Expose the post-handshake channel (binary frames only, each AEAD-sealed under the §15.5
      //    step-4 session key; the handshake used strings).
      return {
        channel: wrapDataChannel(
          dc,
          inbox,
          opStash,
          cleanup,
          p2p,
          sessionKey,
          isOfferer,
          closeNotifier,
        ),
        peerDeviceId: provenPeerDeviceId, // the handshake-PROVEN id, not the rendezvous claim
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  };

  // 2. Discover + dial.  Poll the rendezvous, open every candidate announcement (skipping self /
  //    unopenable / an already-connected / a recently-FAILED peer), Tier-2-filter the capped ones,
  //    then try EACH surviving candidate in turn (PRIV-CARRIER-3): the first that connects wins, so a
  //    stale `candidates[0]` no longer fails the whole connect.  A peer that fails to dial is cooled
  //    down so a re-poll does not immediately re-pick it; when no FRESH candidate remains we surface
  //    the last dial failure (a typed error) rather than silently burning the deadline into a generic
  //    `timeout`.  The whole loop is bounded by the overall `deadline`/abort via `throwIfAborted`.
  // Failed-dial cooldown keyed by the announcement's EPHEMERAL signaling public key — NOT the claimed
  // device id / blind id.  Both of those are derivable from a device id by ANY room member (the blind
  // id is `derivePeerBlindId(device id)`), so keying on them lets a hostile member announce under an
  // honest device's id, fail/time-out, and then PERSISTENTLY suppress the honest member's real
  // candidate (same stable id) for the cooldown window.  The per-announcement ephemeral key is not
  // forgeable that way: a hostile announcement carries its OWN key (cooling only itself), and the
  // worst case — copying the honest member's CURRENT ephemeral key — yields only TRANSIENT suppression
  // that the honest member's next re-announce (a fresh ephemeral) clears.  (PRIV-CARRIER-3-COOLDOWN.)
  const failedPeers = new Map<string, number>(); // signaling_public_key → cooldown-until (ms)
  let lastDialError: unknown;
  // §15.2 discovery-poll backoff (PRIV-CARRIER-POLL-BACKOFF): start responsive (`pollIntervalMs`) but
  // RAMP the empty-poll wait toward a cap, so a member that is under `maxPeers` in a SMALL room (the
  // common case — a mesh dial perpetually seeks a peer that is not there) does not hammer the
  // GLOBAL-rate-limited rendezvous `/poll` at 1/`pollIntervalMs` for the entire dial window (which
  // trips the server's coarse fixed-window budget once a few members mesh, starving discovery).  Reset
  // the instant a FRESH candidate appears, so discovery stays fast when there is someone to dial.
  const maxDiscoveryPollBackoffMs = Math.max(pollIntervalMs, 4_000);
  let discoveryPollBackoffMs = pollIntervalMs;
  /** Dial attempts made this connect — the alternation counter (see
   *  `pickDialCandidate`). */
  let dialRound = 0;
  for (;;) {
    // The whole discovery loop is deadline/abort-bounded.  An explicit abort ends it with the
    // `aborted` error; when the DEADLINE runs out, surface the typed DIAL failure if we attempted one
    // (more actionable than a generic `timeout`), else the timeout itself.  Crucially we keep polling
    // UNTIL that deadline — we do NOT bail after the first failed dial round (PRIV-CARRIER-3-POLL).
    if (params.signal?.aborted) throwIfAborted();
    if (nowMs() >= deadline) {
      if (lastDialError !== undefined) throw lastDialError;
      throwIfAborted();
    }
    const records = await rendezvous.poll(roomBlindId);
    const opened: Candidate[] = [];
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
    // Dedup by the ACTUAL dialed identity (the per-announcement ephemeral `signaling_public_key`) and
    // sort freshest-first — NEVER by the unauthenticated claimed `peer_device_id`; see
    // `selectFreshestCandidates` for why keying on the claimed id would let a spoof evict an honest peer
    // (PRIV-CARRIER-FRESHEST / -NOSPOOF).
    let candidates: Candidate[] = selectFreshestCandidates(opened);
    if (params.rendezvousCap) {
      const capped = candidates.filter((o) => o.ann.cap !== undefined);
      const uncapped = candidates.filter((o) => o.ann.cap === undefined);
      const survivors = params.rendezvousCap.filterVerified(
        capped.map((o) => {
          const c = o.ann.cap as { proof: string; pseudonym: string };
          // The dial identity from THIS announcement: the proof is bound to it, so a
          // lifted cap verifies against nothing here.
          return {
            ...c,
            signalingPublicKey: p2p.fromBase64Url(o.ann.signaling_public_key),
            peerDeviceId: o.ann.peer_device_id,
          };
        }),
        roomBlindId,
        epoch,
        timeBucket,
        nowMs(),
      );
      // A present-but-UNVERIFIABLE cap is DROPPED (in neither set) — the cap's whole PURPOSE is to
      // keep a flooder's caps off the dial budget (TIER2 §1), and §6.8 sanctions the poller ignoring
      // unverifiable ones.  This does NOT violate the §6.10 invariant-4 "never lock an honest member
      // out": that fail-open is an ANNOUNCE-side property (a member that cannot build a VERIFIABLE cap
      // omits it and rides Tier-1 as `uncapped`, above), and a genuine per-device issuer-key divergence
      // is a PRE-first-sync transient the op-log/snapshot converges (`coordinator.ts` canonicalIssuerKey)
      // while local_mdns / member / manual discovery (§15.2) bridge the interim — the cap is a
      // prioritization/anti-flood layer, not the sole discovery path.  Degrading unverifiable caps to
      // Tier-1 here would instead hand the dial budget straight back to the flood (the exact attack the
      // cap exists to bound), so it is deliberately NOT done (PRIV-CAP-DROP-UNVERIFIED).
      candidates = [...survivors.map((i) => capped[i] as Candidate), ...uncapped];
    }

    // Drop peers still in their failure cooldown (pruning expired cooldowns so a peer can be retried
    // later if the deadline still allows).
    const now = nowMs();
    for (const [id, until] of failedPeers) if (until <= now) failedPeers.delete(id);
    const triable = candidates.filter((c) => !failedPeers.has(c.ann.signaling_public_key));

    if (triable.length === 0) {
      // Nothing FRESH to dial this round — but do NOT bail.  A reachable peer may announce shortly, or
      // a cooled-down candidate's cooldown may expire (we prune expired cooldowns above), both within
      // the deadline.  Keep polling; the deadline check at the top surfaces `lastDialError` only when
      // time actually runs out, so a stale-presence-then-live-peer room still converges
      // (PRIV-CARRIER-3-POLL).  Back off the empty-poll cadence so an under-filled room does not flood
      // the rendezvous (PRIV-CARRIER-POLL-BACKOFF).
      await sleep(discoveryPollBackoffMs);
      discoveryPollBackoffMs = Math.min(discoveryPollBackoffMs * 2, maxDiscoveryPollBackoffMs);
      continue;
    }
    // A fresh candidate appeared — return to the responsive discovery cadence.
    discoveryPollBackoffMs = pollIntervalMs;

    // ONE candidate per round — the FRESHEST — then re-poll (PRIV-CARRIER-FRESH-VIEW).
    //
    // A handshake needs BOTH peers to pick each OTHER'S CURRENT announcement: the
    // signalling channel key is ECDH(own ephemeral, the peer's ANNOUNCED ephemeral),
    // and each dial mints a fresh ephemeral whose inbound queue only THAT dial
    // drains.  Every superseded announcement therefore names an address nobody
    // answers at — and it stays live for the §15.3.2 TTL (5-minute floor), because
    // there is no retraction and the store keys presence by the sealed ciphertext,
    // so a re-announce ADDS a slot instead of replacing the device's.
    //
    // Draining the whole `triable` list before re-polling is what turned that into a
    // LIVE-LOCK.  Each stale candidate costs a full per-candidate deadline, so a
    // round could burn `candidates × deadline` against a view that was already out
    // of date when the round began — while the peer, symmetrically stuck, kept
    // announcing newer ephemerals this round would never see.  Measured on the
    // three-browser mesh gate: one peer held THREE live candidates for a single
    // device and the pair converged in roughly one run in three.
    //
    // Freshest-first ORDER was already correct; what was missing is that the choice
    // must be made against a CURRENT view.  Taking one candidate per round makes the
    // two sides' selections converge within a poll interval instead of a
    // list-length multiple of the dial deadline.
    //
    // The anti-spoof property is unchanged (PRIV-CARRIER-FRESHEST-NOSPOOF): a spoof
    // sealed with a later `expires_at` is still dialled FIRST, still rejected by the
    // §15.5 mismatch check, and still suppressed by the ephemeral-keyed cooldown —
    // the honest candidate is simply reached on the next round rather than later in
    // the same one, and the cooldown guarantees the spoof is not retried ahead of it.
    //
    // A flooder ROTATING its ephemeral defeats that cooldown, though — every
    // re-poll hands it a fresh head-of-list record — so the round alternates
    // between the freshest and the most starved candidate (`pickDialCandidate`).
    const candidate = pickDialCandidate(triable, dialRound);
    dialRound += 1;
    if (candidate !== undefined) {
      throwIfAborted();
      const peer: DiscoveredPeer = {
        peerBlindId: candidate.record.peer_blind_id,
        peerDeviceId: candidate.ann.peer_device_id,
        peerSignalingPublicKey: p2p.fromBase64Url(candidate.ann.signaling_public_key),
      };
      try {
        return await dialCandidate(peer);
      } catch (error) {
        // An overall abort/deadline propagates (the whole connect is cancelled); otherwise THIS peer
        // just failed — remember the typed error, cool the peer down, and re-poll for a fresher view.
        throwIfAborted();
        lastDialError = error;
        failedPeers.set(candidate.ann.signaling_public_key, nowMs() + failedPeerCooldownMs);
      }
    }
    // Loop to RE-POLL: the peer may have announced a newer ephemeral while this
    // candidate was being dialled, and that newer one is the only address it now
    // answers at.  (All cooled down → the `triable.length === 0` branch above
    // surfaces `lastDialError` when the deadline runs out.)
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
 * failure by ICE-restart, before it escalates to a hard drop.  Only the OFFERER re-offers (avoiding
 * offer glare); the ANSWERER reacts to the re-offer via the still-live sealed signaling.  BOTH roles,
 * however, run the SELF-DRIVING bounded loop (it re-checks after each attempt rather than waiting for
 * the ICE state to re-fire, which a stuck `disconnected` path may never do): attempts are bounded per
 * episode and reset once the connection returns to `connected`/`completed`; on exhaustion it calls
 * `onExhausted` to tear the connection down so the caller re-dials.  The ANSWERER's loop is what
 * closes PRIV-CARRIER-ANSWERER: when the offerer VANISHES (a hard drop / tab kill fires no DTLS
 * close_notify, so `dc.onclose` never fires and no recovery re-offer ever arrives), the answerer would
 * otherwise strand its session + occupy a mesh fan-out slot forever — instead its give-up tears the
 * connection down so maintainConnection/maintainMesh re-dial + prune.
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
        // Exhausted on a still-bad path: hand off to teardown so the caller re-dials.  BOTH roles reach
        // here — the OFFERER after its re-offers failed to heal the path, the ANSWERER after no recovery
        // re-offer arrived from a vanished offerer (PRIV-CARRIER-ANSWERER).
        recovering = false;
        p.onExhausted();
        return;
      }
      attempts += 1;
      p.signaling.noteActivity(); // keep polling fast so a recovery re-offer/answer lands promptly
      // Only the OFFERER re-offers (avoids offer glare); the ANSWERER just waits for the offerer's
      // re-offer to heal the path, counting down the SAME bounded give-up so a vanished offerer is
      // never waited on forever.
      if (p.isOfferer) {
        await p.signaling.triggerIceRestart().catch(() => {
          /* a failed re-offer just leaves the path bad; the next re-check escalates */
        });
      }
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
    if (recovering) return; // one recovery/give-up chain at a time (both roles)
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
  // Cap the out-of-order ICE buffer: a buggy/malicious member can send sealed ICE candidates that
  // ALWAYS reject, and without a bound they would accumulate for the connection's lifetime + be replayed
  // on every later renegotiation.  Beyond the cap we drop (a real negotiation needs only a handful) (#AZ).
  const MAX_PENDING_ICE = 64;
  const bufferIce = (candidate: RtcIceCandidateInit): void => {
    if (pendingIce.length < MAX_PENDING_ICE) pendingIce.push(candidate);
  };
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
    // §15.4 relay-only IP suppression applied BEFORE a candidate leaves this device.  The filter both
    // DROPS IP-revealing candidate types AND scrubs the raddr/rport related-address on a surviving
    // relay candidate (PRIV-SYNC-3), so the candidate that goes ON THE WIRE is the FILTERED one
    // (`allowed[0]`) — NOT the original `line`, which would still carry the host's related address.
    const allowed = p2p.filterIceCandidatesForMode(p.transportMode, [line]);
    const candidateLine = allowed[0];
    if (candidateLine === undefined) return;
    // Carry sdpMid/sdpMLineIndex: a real addIceCandidate rejects a candidate with neither
    // (the line alone does not identify the m-line), silently dropping every candidate.
    // A dropped trickle candidate is non-fatal (ICE retries / the other candidates cover it),
    // but the POST can reject transiently (offline, 5xx, rate-limit).  Swallow it with a dev
    // warning so a flaky rendezvous never surfaces as an unhandled promise rejection.
    void sendSignal({
      schema: 'licio.private.signaling_payload.v1',
      kind: 'ice',
      ice_candidate: candidateLine,
      sdp_mid: cand?.sdpMid ?? null,
      sdp_mline_index: cand?.sdpMLineIndex ?? null,
    }).catch((error) => devWarn('ICE trickle signal send failed', error));
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
      // The channel may have been torn down (stop / abort) WHILE setRemoteDescription / createAnswer /
      // setLocalDescription awaited — re-check before publishing the answer, or a dead link would emit
      // a sealed answer for an ICE-restart offer and make the peer renegotiate a connection that is
      // already gone (the answer-side counterpart of #ZZ) (#BB).
      if (stopped || p.isAborted()) return;
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
          // setRemoteDescription, instead of dropping them and stranding the restart — bounded (#AZ).
          bufferIce(candidate);
        }
      } else {
        bufferIce(candidate); // can't add before the remote description is set — bounded (#AZ)
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
    // The channel may have been torn down (stop / abort) WHILE createOffer/setLocalDescription
    // awaited — re-check before publishing the restart offer, or a dead link would emit fresh sealed
    // signaling after cleanup and make the peer renegotiate a connection that is already gone (#ZZ).
    if (stopped || p.isAborted()) return;
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
  // PRIV-CARRIER-1: the rendezvous server is UNTRUSTED, so enforce signal expiry + replay dedup on
  // the CLIENT.  `aeadSeal` uses a fresh random nonce, so a replayed signal is byte-identical — a
  // stable prefix of its ciphertext (past the random nonce) is the dedup key.  The map is bounded
  // THREE ways so a malicious server cannot grow it without limit (PRIV-CARRIER-DEDUP-BOUND):
  //   • a signal whose `expires_at` exceeds the legit bound (a sender stamps exactly `ttlMs`, plus a
  //     clock-skew grace) is REJECTED — the untrusted server cannot set a FAR-FUTURE expiry to pin a
  //     dedup entry past the prune (the old code trusted the server-supplied expiry it was meant to
  //     defend against, so an entry with `expires_at = 1e18` was NEVER pruned → unbounded growth);
  //   • the stored expiry is therefore ≤ `now + ttlMs + grace`, so pruning ALWAYS fires within ~5 min;
  //   • the map is keyed on a COMPACT ciphertext prefix and HARD-CAPPED at `MAX_SEEN_SIGNALS` with
  //     oldest-first eviction — bounding BOTH the entry count AND the per-entry size regardless of the
  //     flood rate or the server's claims.
  // An evicted-then-replayed signal is merely re-processed (`openSignal` is the real gate — a garbage
  // signal fails to open and applyPayload is idempotent for offer/answer/ICE), never mis-applied.
  const seenSignalKeys = new Map<string, number>(); // dedup key (ciphertext prefix) → clamped expiry
  const SIGNAL_SKEW_GRACE_MS = 5_000;
  // The future-expiry acceptance window MUST match the server's rendezvous clock-skew tolerance
  // (`clockSkewToleranceMs` = 5 min): the server ACCEPTS + stores an AAD-bound signal whose `expires_at`
  // is up to that far ahead (a sender stamps expiry off its OWN clock).  Rejecting a legitimately
  // skewed signal here with the tight 5 s grace would silently drop valid offer/answer/ICE from a
  // clock-ahead mobile device and block WebRTC setup, so use the SAME window (PRIV-CARRIER-SKEW).
  const SIGNAL_CLOCK_SKEW_MS = 5 * 60 * 1000;
  const MAX_SEEN_SIGNALS = 4_096;
  const SIGNAL_DEDUP_KEY_LEN = 64; // base64 chars past the 12-byte AEAD nonce ⇒ unique per seal
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
      const nowMs = p.nowMs();
      // The furthest-future expiry a LEGITIMATE signal can claim: a sender stamps exactly `p.ttlMs`
      // ahead of its own clock, plus the server's clock-skew window.  Anything beyond this is an
      // untrusted-server forgery (still bounded by MAX_SEEN_SIGNALS regardless).
      const maxExpiry = nowMs + p.ttlMs + SIGNAL_CLOCK_SKEW_MS;
      for (const signal of signals) {
        // Drop a clearly-EXPIRED signal (with a small clock-skew grace) — it must not be applied,
        // and it should not enter the dedup set (PRIV-CARRIER-1).
        if (signal.expires_at + SIGNAL_SKEW_GRACE_MS < nowMs) continue;
        // Drop a signal claiming an expiry BEYOND what a legit sender ever stamps: the untrusted
        // server cannot use a far-future `expires_at` to defeat expiry-based pruning of the dedup set.
        if (signal.expires_at > maxExpiry) continue;
        const dedupKey = signal.ciphertext.slice(0, SIGNAL_DEDUP_KEY_LEN);
        // Reject an in-window REPLAY (a byte-identical re-delivery of an already-seen signal).
        if (seenSignalKeys.has(dedupKey)) continue;
        // Hard-cap the dedup set (oldest-first eviction) so it stays bounded regardless of flood rate.
        if (seenSignalKeys.size >= MAX_SEEN_SIGNALS) {
          const oldest = seenSignalKeys.keys().next().value;
          if (oldest !== undefined) seenSignalKeys.delete(oldest);
        }
        seenSignalKeys.set(dedupKey, signal.expires_at); // ≤ maxExpiry ⇒ prunes within ~5 min
        try {
          await applyPayload(await p2p.openSignal(signal, p.channelKey));
        } catch (error) {
          // A signal we can't open (foreign/tampered) fails closed — skip it, but surface it in
          // dev: a persistent failure here is a real bug (bad key/codec), not just a probe.
          devWarn('skipped a signal that failed to open or apply', error);
        }
      }
      // Prune expired dedup entries so the set stays bounded over the long-lived loop.
      for (const [k, exp] of seenSignalKeys) {
        if (exp + SIGNAL_SKEW_GRACE_MS < nowMs) seenSignalKeys.delete(k);
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
): Promise<{ opStash: Uint8Array[]; sessionKey: Uint8Array; peerDeviceId: string }> {
  const { p2p, dc } = p;
  const ctx = {
    protocolVersion: p2p.HANDSHAKE_PROTOCOL_VERSION,
    roomIdCommitment: p.roomIdCommitment,
    epoch: p.epoch,
  };

  const ephemeral = await p2p.generateX25519KeyPair();
  const selfHello = p2p.buildHandshakeHello({
    deviceId: p.selfDeviceId,
    ephemeralPublicKey: ephemeral.publicKey,
    helloNonce: p2p.randomBytes(32),
    protocolVersion: p2p.HANDSHAKE_PROTOCOL_VERSION,
  });

  let remoteHello: HandshakeHello | undefined;
  let remoteProofSig: Uint8Array | undefined;
  // §15.5 step 4 — the pairwise data-channel session key, derived from the handshake
  // ephemeral ECDH + transcript once the remote device is verified (set before
  // resolveDone, so it is defined whenever `done` resolves).
  let sessionKey: Uint8Array | undefined;
  // The device id captured AT the point its hello passes `verifyPeerHandshake` — bound here
  // (not re-read from the mutable `remoteHello` after `done` resolves), so a later queued hello
  // claiming a different device cannot overwrite the attribution the caller relies on.
  let provenDeviceId: string | undefined;
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
    // Snapshot the hello being verified NOW.  `remoteHello` is mutable (the inbox handler can
    // overwrite it with a later queued hello), so everything below — the proof verification, the
    // session-key derivation, AND the captured device id — must read this immutable snapshot, not
    // the live field, or a post-verification hello could swap the attributed device.
    const verifyingHello = remoteHello;
    const resolved = p.resolveDevice(verifyingHello.author_device_id);
    const result = await p2p.verifyPeerHandshake({
      localHello: selfHello,
      remoteHello: verifyingHello,
      remoteProofSignature: remoteProofSig,
      ctx,
      resolveDevice: (deviceId) => {
        if (!resolved || deviceId !== verifyingHello.author_device_id) return undefined;
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
      p2p.fromBase64Url(verifyingHello.ephemeral_public_key),
      selfHello,
      verifyingHello,
      ctx,
    );
    // Bind the proven id to the hello that actually verified — immutable from here.
    provenDeviceId = verifyingHello.author_device_id;
    resolveDone();
  };

  // Pre-import the remote device key (verifyPeerHandshake's resolveDevice is sync).
  let resolvedDevice: { publicKey: CryptoKey; activeAtEpoch: boolean } | undefined;
  // Op frames a faster peer sends before our handshake finishes — handed to the channel.  CAPPED:
  // before the remote proves membership it is UNTRUSTED, so a peer that reaches the channel but
  // slowplays/fails the proof cannot grow renderer memory by streaming frames for the whole handshake
  // timeout — frames beyond the cap are dropped (the op-exchange re-requests anything dropped) (#YY).
  const opStash: Uint8Array[] = [];
  const MAX_PRE_HANDSHAKE_STASH_BYTES = 1_048_576; // 1 MiB — ample for a few op frames, bounded
  let opStashBytes = 0;

  // Process handshake frames STRICTLY SEQUENTIALLY: a proof frame must never run while a prior
  // hello's async device-key import is still pending, or tryVerify would see remoteHello +
  // remoteProofSig but resolvedDevice still undefined and reject a valid member as unknown (#FF).
  let handshakeChain: Promise<void> = Promise.resolve();
  p.inbox.consume((data): void => {
    if (typeof data !== 'string') {
      const bytes = toUint8(data as ArrayBuffer | ArrayBufferView); // not a handshake frame
      if (opStashBytes + bytes.byteLength > MAX_PRE_HANDSHAKE_STASH_BYTES) return; // cap — drop (#YY)
      opStashBytes += bytes.byteLength;
      opStash.push(bytes);
      return;
    }
    handshakeChain = handshakeChain
      .then(async (): Promise<void> => {
        // Once the handshake has SETTLED (a device verified, or it failed), the outcome is
        // FINAL: ignore any further hello/proof so a later frame can never overwrite the proven
        // device id, the session key, or `remoteHello`.  This makes the first-verification-wins
        // invariant explicit and independent of microtask timing (defence in depth over the
        // immutable `provenDeviceId` capture in `tryVerify`).
        if (settled) return;
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
      })
      .catch((error) => rejectDone(error)); // a thrown error fails fast, not via timeout
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
  if (provenDeviceId === undefined)
    throw new ConnectPrivatePeerError(
      'handshake_no_proven_device',
      'handshake settled without a proven device id',
    );
  // The PROVEN device id (registered + active-at-epoch + Ed25519-proven by
  // `verifyPeerHandshake`) — captured at verification time, NOT re-read from the mutable
  // `remoteHello` (a later hello could overwrite it) and NOT the rendezvous-claimed id (any
  // current-epoch member can seal that with an arbitrary value).  The caller keys its
  // mesh/exclude/cooldown sets on this.
  return { opStash, sessionKey, peerDeviceId: provenDeviceId };
}

// --- the post-handshake PeerChannel -------------------------------------------------

function toUint8(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * The AEAD AAD binding a post-handshake op frame under the §15.5 step-4 session key.  The
 * tag is DIRECTION-SEPARATED by role (offerer→answerer vs. answerer→offerer): each peer seals
 * with its send-direction tag and opens only the OPPOSITE tag.  So a relay that reflects a
 * peer's own frame back cannot open it, and the two directions are cryptographically
 * distinguished — not merely non-colliding by random nonce.  Both peers agree on the mapping
 * via the deterministic `isOfferer` (the bytewise-smaller blind id offers).  This is a
 * `HANDSHAKE_PROTOCOL_VERSION`-3 wire format (v3 added datachannel FRAGMENTATION of the sealed frame
 * — see `wrapDataChannel` — so a large media/snapshot sync message can cross a finite SCTP message
 * limit; a v2 peer sent whole frames and is incompatible, so the AAD is bumped in lockstep with the
 * version).  A version skew is rejected at the handshake (see the constant), so within a live session
 * both peers are always on the same op-frame format.
 */
const OP_FRAME_AAD_O2A = new TextEncoder().encode('licio.private.op-frame.v3.o2a');
const OP_FRAME_AAD_A2O = new TextEncoder().encode('licio.private.op-frame.v3.a2o');

function wrapDataChannel(
  dc: RtcDataChannelLike,
  inbox: MessageInbox,
  opStash: Uint8Array[],
  cleanup: () => void,
  p2p: ConnectPrivatePeerParams['p2p'],
  sessionKey: Uint8Array,
  isOfferer: boolean,
  /** Registered with `handleClose` so the dialer's `cleanup()` can DETERMINISTICALLY drive the
   *  session's onClose without relying on pc.close() firing dc.onclose (PRIV-CARRIER-TEARDOWN). */
  closeNotifier: { fire: (() => void) | null },
): PeerChannel {
  // Seal with our send direction; open only the peer's send (= our receive) direction.
  const sendAad = isOfferer ? OP_FRAME_AAD_O2A : OP_FRAME_AAD_A2O;
  const recvAad = isOfferer ? OP_FRAME_AAD_A2O : OP_FRAME_AAD_O2A;
  const buffered: Uint8Array[] = [];
  let listener: ((frame: Uint8Array) => void) | null = null;
  let closeListener: (() => void) | null = null;

  // --- SCTP backpressure (PRIV-SYNC-FRAGMENT): a large sealed sync message is FRAGMENTED (below), so
  // sending its hundreds of fragments back-to-back would overrun the SCTP send buffer and `dc.send`
  // would throw mid-stream, truncating the message the peer's reassembler then rejects.  Pause sends
  // once `bufferedAmount` exceeds the high-water mark until `onbufferedamountlow` (or a safety timeout).
  const DRAIN_HIGH_WATER = 8 * 1024 * 1024;
  const DRAIN_LOW_WATER = 1 * 1024 * 1024;
  const MAX_DRAIN_WAITS = 30; // ≈60 s before declaring the channel stuck
  let drainWaiters: Array<() => void> = [];
  const wakeDrainWaiters = (): void => {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const wake of waiters) wake();
  };
  if ('bufferedAmountLowThreshold' in dc) {
    dc.bufferedAmountLowThreshold = DRAIN_LOW_WATER;
    dc.onbufferedamountlow = () => wakeDrainWaiters();
  }
  const awaitDrain = async (): Promise<void> => {
    if (typeof dc.bufferedAmount !== 'number') return; // a fake/non-buffering channel
    let waits = 0;
    while (dc.readyState === 'open' && (dc.bufferedAmount ?? 0) > DRAIN_HIGH_WATER) {
      if (++waits > MAX_DRAIN_WAITS) return; // stuck — stop waiting; the send below fails on the full channel
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 2_000);
        drainWaiters.push(finish);
      });
    }
  };

  // A remote drop (the data channel closes underneath us) both notifies the session AND runs
  // cleanup — closing the pc + halting the long-lived maintenance signaling loop so it does
  // not leak past the connection.  An in-place ICE-restart does NOT close the data channel
  // (the SCTP/DTLS association survives), so this fires only on a genuine, unrecoverable drop;
  // the session's onClose then drives `maintainConnection` to re-dial.
  let channelClosed = false;
  const handleClose = (): void => {
    if (channelClosed) return; // fire the session notify + cleanup AT MOST ONCE
    channelClosed = true;
    wakeDrainWaiters(); // unblock any send parked on backpressure so it observes the close
    closeListener?.();
    cleanup();
  };

  // Open a sealed frame under the §15.5 step-4 session key, then deliver the plaintext.
  // A frame that does not open (tampered, or not sealed by the session-key holder) is
  // DROPPED fail-closed — a DTLS-terminating relay cannot inject or read op frames.
  const openAndDeliver = (sealed: Uint8Array): void => {
    void p2p
      .aeadOpen(sessionKey, sealed, recvAad)
      .then((frame) => {
        if (listener) listener(frame);
        else buffered.push(frame);
      })
      .catch(() => {
        /* not openable under the session key → drop (fail-closed) */
      });
  };

  // Inbound datachannel messages are FRAGMENTS of a sealed sync frame (v3): reassemble, then open the
  // whole sealed message.  A framing violation (reorder / over-cap / a fragment disagreeing with the
  // in-flight message) is fail-closed — DROP the corrupt message + RESET the reassembler (recreate it)
  // so the channel survives and the op-exchange re-requests what was lost, rather than tearing the
  // whole connection down on a single bad/dropped fragment (an ordered+reliable channel only sees this
  // under active tampering or the pre-handshake stash cap, both of which the §15.7 walk recovers from).
  let reassembler = new p2p.PrivateFragmentReassembler();
  const acceptFragment = (fragment: Uint8Array): void => {
    let complete: Uint8Array | null;
    try {
      complete = reassembler.accept(fragment);
    } catch {
      reassembler = new p2p.PrivateFragmentReassembler(); // reset; the message is dropped fail-closed
      return;
    }
    if (complete) openAndDeliver(complete);
  };

  // The fragments a faster peer sent during our handshake (stashed as binary frames) come FIRST, in
  // order, through the SAME reassembler as the live fragments (the datachannel is ordered).
  for (const fragment of opStash) acceptFragment(fragment);
  inbox.consume((data): void => {
    if (typeof data === 'string') return; // no string frames post-handshake
    acceptFragment(toUint8(data as ArrayBuffer | ArrayBufferView));
  });
  dc.onclose = handleClose;
  // Let the dialer's cleanup() drive this same close-notification (idempotent via the guard above), so
  // an ICE-restart exhaustion / answerer give-up teardown notifies the session even on a real browser
  // where pc.close() does NOT dispatch dc.onclose (PRIV-CARRIER-TEARDOWN).
  closeNotifier.fire = handleClose;
  // If the channel ALREADY closed/closing by the time we wrap it (it dropped during the handshake),
  // `onclose` may never fire — notify the session + tear down on a microtask so it can re-dial,
  // mirroring armChannel's already-open handling (PRIV-CARRIER-2).
  if (dc.readyState === 'closed' || dc.readyState === 'closing') {
    queueMicrotask(handleClose);
  }

  // Single-flight sends (a per-channel chain) so two messages' fragments never interleave on the one
  // ordered datachannel (the receiver reassembles ONE message at a time), and each fragment waits for
  // the SCTP buffer to drain first.  A monotonically-increasing message id lets the receiver detect a
  // message boundary.
  let sendChain: Promise<void> = Promise.resolve();
  let nextMessageId = 0;

  return {
    send(frame: Uint8Array): Promise<void> {
      const run = sendChain.then(async () => {
        const sealed = await p2p.aeadSeal(sessionKey, frame, sendAad);
        const id = nextMessageId;
        nextMessageId = (nextMessageId + 1) >>> 0; // wrap as u32; ids need not be unique forever
        for (const fragment of p2p.fragmentPrivateMessage(sealed, id)) {
          await awaitDrain();
          if (dc.readyState !== 'open') return; // channel closed mid-send → stop (fail closed)
          // A fresh, exactly-sized frame — send its own buffer (the channel owns the bytes).
          dc.send(fragment.slice().buffer);
        }
      });
      sendChain = run.then(
        () => undefined,
        () => undefined, // a failed send must not wedge later sends (each caller still sees its own error)
      );
      return run;
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
