// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Idempotent ingestion pre-gate (OFFLINE_SPEC §16.9, §16.11, WS-R.6.5).
// Acceptance is keyed by `record_cid` (the hash of the deterministic body, proof
// bytes excluded), so re-submitting the same body + an equivalent proof is a
// no-op that returns `already_have` — never a duplicated effect.  A different
// body claiming an already-used `(device_key_id, device_seq)` is a
// `conflict_device_fork`, not a duplicate.  This pre-gate runs BEFORE the
// `validate()` / conflict-dispatch path (which handles everything else).  Pure.

import type { ObjectStatusCode } from '../pack/status.js';

/** The idempotency key for acceptance — the record CID, by §16.9. */
export function acceptanceKey(recordCid: string): string {
  return recordCid;
}

export interface ResubmissionInput {
  /** We already hold this `record_cid` with an equivalent (verifying) proof. */
  readonly alreadyHave: boolean;
  /** A DIFFERENT body claims an already-used `(device_key_id, device_seq)`. */
  readonly deviceSeqConflict: boolean;
}

/**
 * The short-circuit status for a re-submission, or `undefined` to proceed to
 * normal ingestion.  A device-sequence conflict takes precedence over a plain
 * duplicate (a fork must never be hidden behind `already_have`).
 */
export function classifyResubmission(input: ResubmissionInput): ObjectStatusCode | undefined {
  if (input.deviceSeqConflict) return 'conflict_device_fork';
  if (input.alreadyHave) return 'already_have';
  return undefined;
}
