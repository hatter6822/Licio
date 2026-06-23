// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.6 — snapshots (PRIVATE_SPEC §14.5, §25.6): an optimization hint, NEVER
// authority on its own.  A `snapshot.commit` op only enters the reducer if its
// author holds `admin` (the fold's capability gate), and a snapshot is USED only
// after its `state_merkle_root` is re-verified against the accepted ops it
// claims to cover — so a forged/stale root can never substitute for replay.
// Encrypted op history is retained by default (compaction needs room policy +
// member agreement); this module owns the verify-before-use + cadence math.

import { sha256, toBase64Url } from '../crypto/runtime.js';
import type { PrivateRoomOp } from '../schemas/ops.js';
import { reduceRoom } from './reduce.js';
import { roomStateCommitment } from './state.js';

/** The §25.6 cadence thresholds (snapshot every N ops or after a time window). */
export const SNAPSHOT_CADENCE = {
  everyOps: 1000,
  everyMs: 7 * 24 * 60 * 60 * 1000, // 7 days
} as const;

/**
 * The verifiable state root a `snapshot.commit` carries: a commitment over the
 * canonical reduced state (`state_merkle_root`).  A single SHA-256 over the
 * deterministic state commitment — equal logical state ⇒ equal root.
 */
export async function computeStateRoot(coveredOps: readonly PrivateRoomOp[]): Promise<string> {
  return toBase64Url(await sha256(roomStateCommitment(reduceRoom(coveredOps))));
}

/**
 * Verify a snapshot's declared `state_merkle_root` against the accepted ops it
 * covers (§14.5 "trusted only ... verified against accepted ops").  Returns
 * `true` only when the recomputed root byte-matches; never trusts the snapshot
 * body on its own.
 */
export async function verifySnapshotRoot(
  declaredRoot: string,
  coveredOps: readonly PrivateRoomOp[],
): Promise<boolean> {
  return (await computeStateRoot(coveredOps)) === declaredRoot;
}

/** Inputs to the §25.6 cadence decision. */
export interface SnapshotCadenceInput {
  readonly opsSinceLastSnapshot: number;
  readonly msSinceLastSnapshot: number;
  /** A large import just completed (§25.6 "immediate snapshot after large import"). */
  readonly afterLargeImport?: boolean;
  /** Membership churn just occurred (add/remove → epoch change). */
  readonly afterMembershipChurn?: boolean;
  /** The user invoked "optimize room storage". */
  readonly manual?: boolean;
}

/**
 * Decide whether to create a snapshot now (§25.6): every ~1000 accepted ops or
 * 7 days, immediately after a large import or membership churn, or on a manual
 * request.  Bounds unbounded replay cost.
 */
export function shouldCreateSnapshot(input: SnapshotCadenceInput): boolean {
  return (
    input.manual === true ||
    input.afterLargeImport === true ||
    input.afterMembershipChurn === true ||
    input.opsSinceLastSnapshot >= SNAPSHOT_CADENCE.everyOps ||
    input.msSinceLastSnapshot >= SNAPSHOT_CADENCE.everyMs
  );
}

/**
 * Whether encrypted op history may be COMPACTED (pruned).  Retained by default
 * (§14.5): compaction requires the room policy to allow it AND enough members to
 * agree.  A pure policy predicate — the reducer never prunes on its own.
 */
export function mayCompactHistory(
  policyAllowsCompaction: boolean,
  agreeingMembers: number,
  requiredAgreements: number,
): boolean {
  return policyAllowsCompaction && requiredAgreements >= 1 && agreeingMembers >= requiredAgreements;
}
