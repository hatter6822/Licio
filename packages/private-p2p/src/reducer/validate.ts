// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.3 — the structural validation pre-pass (PRIVATE_SPEC §14.2 steps 6, 9,
// 10 + the §14.3.1 Lamport rule).  This is the portion of the §14.2 pipeline that
// is a PURE function of the candidate op set — it produces the "accepted" set the
// deterministic fold (WS-S.5.4b) consumes, quarantining the rest with a reason
// (quarantined ops MUST NOT render, §14.2).  Run in the §14.3.2 canonical order,
// so a parent (lower lamport) is always seen before its child.
//
// The CRYPTO steps (§14.2 1-5: CID-exists, decode, signature, AEAD-open, schema)
// are the wire-intake stage — they decrypt an envelope to a `PrivateRoomOp` using
// the §10.5 AEAD + §10.7 signature + the §10.2 epoch keys, against the device
// registry the fold builds — and integrate with WS-S.6 sync (tracked next); this
// module assumes already-decrypted, schema-valid `PrivateRoomOp`s and enforces
// the structural invariants that gate acceptance.

import type { PrivateRoomOp } from '../schemas/ops.js';
import { canonicalOpOrder, lamportRespectsCausality } from './order.js';
import type { RejectedOp } from './state.js';

export type QuarantineReason =
  | 'room_mismatch'
  | 'missing_dependency'
  | 'lamport_not_after_parents'
  | 'lamport_jump_exceeded'
  | 'non_monotonic_author_seq'
  | 'duplicate_op_id';

export interface StructuralValidationResult {
  /** The structurally-valid ops, in canonical order, ready for the fold. */
  readonly accepted: PrivateRoomOp[];
  /** The quarantined ops + reason (never rendered, §14.2). */
  readonly quarantined: RejectedOp[];
}

/**
 * A causally-closed prefix already accepted before `candidateOps` — e.g. a §14.5
 * snapshot base whose covered ops are pruned from the candidate set.  Without it,
 * a post-snapshot op whose parent lives in the (pruned) prefix would be wrongly
 * quarantined as a missing dependency, and a device's `author_seq` could appear to
 * "restart" after compaction.
 */
export interface StructuralBaseContext {
  /** Covered op id → its `lamport` (decimal string).  A candidate parent in here
   *  is NOT missing, and its RETAINED lamport is used for the §14.3.1 causality
   *  check exactly as an uncompacted peer would — so a compacted device makes the
   *  IDENTICAL accept/reject decision (never silently skips the check). */
  readonly knownOpLamports?: ReadonlyMap<string, string>;
  /** Per-device max `author_seq` covered by the prefix (the monotonicity floor). */
  readonly deviceSeqFloor?: ReadonlyMap<string, number>;
  /** The max `lamport` (decimal string) covered by the prefix — the §14.3.1 running
   *  ceiling floor, so the anti-DoS lamport-jump cap continues across compaction
   *  identically on every device. */
  readonly maxLamport?: string;
}

/**
 * Run the §14.2 structural checks over `candidateOps` for `roomId`.  In canonical
 * order: reject a `room_id` mismatch (step 6); quarantine an op whose parent is
 * not accepted (step 10 — a genuinely missing dependency); reject a `lamport`
 * not strictly greater than every parent (§14.3.1); reject a non-monotonic
 * per-device `author_seq` (step 9 — also catches a same-seq device fork); reject
 * a duplicate `op_id`.  `base` carries an already-accepted prefix (a §14.5
 * compaction base) so a candidate referencing a pruned parent / continuing a
 * device's seq across the snapshot boundary is not spuriously quarantined.
 */
export function validateStructure(
  candidateOps: readonly PrivateRoomOp[],
  roomId: string,
  base?: StructuralBaseContext,
): StructuralValidationResult {
  const accepted: PrivateRoomOp[] = [];
  const quarantined: RejectedOp[] = [];
  const acceptedLamport = new Map<string, string>();
  // Seed the per-device seq floor + the seen-id set from the accepted prefix.
  const deviceMaxSeq = new Map<string, number>(base?.deviceSeqFloor);
  const seenOpIds = new Set<string>(base?.knownOpLamports?.keys());
  const knownOpLamports = base?.knownOpLamports;
  // Running max lamport over the accepted prefix + this pass (§14.3.1).  A legitimate
  // clock advances by exactly +1 per op (nextLamport = max+1), and a concurrent op is
  // at most max+1 as well, so any op whose lamport exceeds runningMax+1 is a poison op
  // (lamport is attacker-chosen, only lower-bounded by parents) — quarantine it so one
  // op cannot push nextLamport past the 40-digit schema cap and freeze all authoring.
  let runningMax = base?.maxLamport !== undefined ? BigInt(base.maxLamport) : 0n;
  if (knownOpLamports) {
    for (const lamport of knownOpLamports.values()) {
      const v = BigInt(lamport);
      if (v > runningMax) runningMax = v;
    }
  }

  for (const op of canonicalOpOrder(candidateOps)) {
    if (seenOpIds.has(op.op_id)) {
      quarantined.push({ opId: op.op_id, reason: 'duplicate_op_id' });
      continue;
    }
    if (op.room_id !== roomId) {
      quarantined.push({ opId: op.op_id, reason: 'room_mismatch' });
      continue;
    }
    const parentLamports: string[] = [];
    let missingParent = false;
    for (const parent of op.parents) {
      const lamport = acceptedLamport.get(parent);
      if (lamport !== undefined) {
        parentLamports.push(lamport);
        continue;
      }
      // A parent in the accepted prefix (a compacted base) is present, just pruned.
      // Use its RETAINED lamport for the causality check — NOT skip it — so a
      // compacted device rejects a too-low lamport exactly as an uncompacted peer
      // does (else the two diverge on a malicious/stale post-compaction op).
      const baseLamport = knownOpLamports?.get(parent);
      if (baseLamport !== undefined) {
        parentLamports.push(baseLamport);
        continue;
      }
      missingParent = true;
      break;
    }
    if (missingParent) {
      quarantined.push({ opId: op.op_id, reason: 'missing_dependency' });
      continue;
    }
    if (!lamportRespectsCausality(op.lamport, parentLamports)) {
      quarantined.push({ opId: op.op_id, reason: 'lamport_not_after_parents' });
      continue;
    }
    const opLamport = BigInt(op.lamport);
    if (opLamport > runningMax + 1n) {
      quarantined.push({ opId: op.op_id, reason: 'lamport_jump_exceeded' });
      continue;
    }
    const prevSeq = deviceMaxSeq.get(op.author_device_id);
    if (prevSeq !== undefined && op.author_seq <= prevSeq) {
      quarantined.push({ opId: op.op_id, reason: 'non_monotonic_author_seq' });
      continue;
    }

    if (opLamport > runningMax) runningMax = opLamport;
    deviceMaxSeq.set(op.author_device_id, op.author_seq);
    acceptedLamport.set(op.op_id, op.lamport);
    seenOpIds.add(op.op_id);
    accepted.push(op);
  }

  return { accepted, quarantined };
}
