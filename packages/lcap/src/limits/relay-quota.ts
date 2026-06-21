// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Relay-side admission quotas (OFFLINE_SPEC §27.3, §27.4, WS-R.14.4) — a PURE,
// reusable policy the relay service (WS-R.15.3) consumes.  A relay reserves capacity
// for the control/text lanes (C0/T1) so trust + core content always have room, and
// caps per-peer / per-room / per-object / unverified-quarantine bytes plus a per-peer
// invalid-object ratio.  Two §27.4 doctrine constraints are STRUCTURAL here:
//
//   - NO client proof-of-work: posting never requires a PoW solve (it burns scarce
//     phone battery and disadvantages low-end devices).  This module exposes no
//     challenge/nonce/difficulty surface.
//   - NO per-IP / network-address state: admission reads only content lane/size +
//     opaque peer/room usage counters, never a client address (§19.1 parity).
//
// I/O-free and deterministic; abuse control is structural, not adaptive.

import { LANE_ORDER, type LcapLane } from '../priority.js';

/** The relay's §27.3 reserved-capacity + quota configuration. */
export interface RelayQuotaConfig {
  /** Total relay storage budget (bytes). */
  readonly totalBytes: number;
  /** Fraction of `totalBytes` reserved per lane (only C0/T1 reserve; lower lanes 0). */
  readonly reservedFractionByLane: Readonly<Partial<Record<LcapLane, number>>>;
  /** Per-peer byte quota. */
  readonly perPeerBytes: number;
  /** Per-room byte quota. */
  readonly perRoomBytes: number;
  /** Max single accepted object size. */
  readonly maxObjectBytes: number;
  /** Max unverified (quarantine) bytes the relay will hold. */
  readonly maxUnverifiedBytes: number;
  /** Throttle a peer whose invalid/seen ratio exceeds this (after the min sample). */
  readonly maxInvalidRatio: number;
  /** Don't apply the invalid-ratio throttle before this many observed objects. */
  readonly invalidRatioMinSample: number;
}

/** A conservative default profile (a server relay). */
export const DEFAULT_RELAY_QUOTA: RelayQuotaConfig = Object.freeze({
  totalBytes: 1024 * 1024 * 1024,
  reservedFractionByLane: Object.freeze({ C0: 0.1, T1: 0.2 }),
  perPeerBytes: 64 * 1024 * 1024,
  perRoomBytes: 256 * 1024 * 1024,
  maxObjectBytes: 16 * 1024 * 1024,
  maxUnverifiedBytes: 64 * 1024 * 1024,
  maxInvalidRatio: 0.5,
  invalidRatioMinSample: 16,
});

/** The current relay usage an admission decision reads (opaque counters; no addresses). */
export interface RelayUsage {
  /** Bytes currently stored per lane (the reservation math reads this). */
  readonly laneUsedBytes: Readonly<Partial<Record<LcapLane, number>>>;
  /** Bytes already stored for the requesting peer. */
  readonly peerBytes: number;
  /** Bytes already stored for the target room. */
  readonly roomBytes: number;
  /** Bytes currently held unverified (quarantine). */
  readonly unverifiedBytes: number;
  /** Objects observed from this peer (the invalid-ratio denominator). */
  readonly peerObjectsSeen: number;
  /** Objects from this peer that failed verification (the numerator). */
  readonly peerObjectsInvalid: number;
}

/** An object the relay is asked to admit. */
export interface AdmissionRequest {
  readonly lane: LcapLane;
  readonly sizeBytes: number;
  /** Verified content vs. unverified quarantine (the latter is bounded separately). */
  readonly verified: boolean;
}

export type AdmissionReason =
  | 'object_too_large'
  | 'peer_quota'
  | 'room_quota'
  | 'unverified_quota'
  | 'invalid_ratio'
  | 'capacity';

export type AdmissionDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: AdmissionReason };

const deny = (reason: AdmissionReason): AdmissionDecision => ({ admit: false, reason });

function laneUsed(usage: RelayUsage, lane: LcapLane): number {
  return usage.laneUsedBytes[lane] ?? 0;
}

/**
 * Decide whether a relay admits an object (§27.3).  Order: object-size cap →
 * per-peer invalid-ratio throttle → per-peer quota → per-room quota → unverified
 * quarantine cap → reserved-capacity check.  The reservation rule: a lane-L object
 * may use the free space MINUS the still-unfilled reserves of every higher-priority
 * lane, so control (C0) and core text (T1) can never be starved by bulk lanes; C0
 * itself (no higher lane) may use all free space.
 */
export function admitRelayObject(
  config: RelayQuotaConfig,
  usage: RelayUsage,
  req: AdmissionRequest,
): AdmissionDecision {
  if (req.sizeBytes > config.maxObjectBytes) return deny('object_too_large');

  if (
    usage.peerObjectsSeen >= config.invalidRatioMinSample &&
    usage.peerObjectsInvalid / usage.peerObjectsSeen > config.maxInvalidRatio
  ) {
    return deny('invalid_ratio');
  }

  if (usage.peerBytes + req.sizeBytes > config.perPeerBytes) return deny('peer_quota');
  if (usage.roomBytes + req.sizeBytes > config.perRoomBytes) return deny('room_quota');
  if (!req.verified && usage.unverifiedBytes + req.sizeBytes > config.maxUnverifiedBytes) {
    return deny('unverified_quota');
  }

  let totalUsed = 0;
  for (const lane of LANE_ORDER) totalUsed += laneUsed(usage, lane);
  const free = config.totalBytes - totalUsed;

  // The unfilled reserves of lanes strictly higher-priority than the request's lane
  // must remain free for them (lower lanes cannot encroach on a higher reserve).
  const reqIndex = LANE_ORDER.indexOf(req.lane);
  let reserveForHigher = 0;
  for (let i = 0; i < reqIndex; i++) {
    const higher = LANE_ORDER[i] as LcapLane;
    const reserve = (config.reservedFractionByLane[higher] ?? 0) * config.totalBytes;
    reserveForHigher += Math.max(0, reserve - laneUsed(usage, higher));
  }

  if (req.sizeBytes > free - reserveForHigher) return deny('capacity');
  return { admit: true };
}
