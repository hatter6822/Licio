// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Device-fork detection + fork evidence (OFFLINE_SPEC §12.2, §19.6, WS-R.2.4).
// Two distinct `record_cid`s sharing `(author_device_key_id, device_seq)` are
// device-fork evidence — regardless of which capability authorized them.  An
// identical re-submission (same `record_cid`) is idempotent, not a fork.  Fork
// evidence is P0/C0 (`CONTROL_PRIORITY`), schedulable ahead of all content, and
// the affected records surface as `conflicting` in trust projection.

import { CONTROL_PRIORITY, type LcapPriority } from '../priority.js';
import { encodeWithSchema } from '../schemas/codec.js';
import { type ForkEvidenceV2, forkEvidenceV2Schema } from '../schemas/records.js';

/** Fork evidence always schedules at P0 / lane C0. */
export function forkEvidencePriority(): LcapPriority {
  return CONTROL_PRIORITY;
}

/** A detected device-sequence fork (the two CIDs sorted deterministically). */
export interface DeviceForkObservation {
  readonly deviceKeyId: string;
  readonly deviceSeq: number;
  readonly objectCidA: string;
  readonly objectCidB: string;
}

/**
 * Detects device-sequence forks as records are observed.  `observe` returns the
 * fork on the first conflicting `(device_key_id, device_seq)` pairing with a
 * different `record_cid`; first-seen pairings and idempotent re-submissions
 * return `undefined`.
 */
export class DeviceForkDetector {
  private readonly seen = new Map<string, string>();

  observe(
    deviceKeyId: string,
    deviceSeq: number,
    recordCid: string,
  ): DeviceForkObservation | undefined {
    const key = `${deviceKeyId}:${deviceSeq}`;
    const existing = this.seen.get(key);
    if (existing === undefined) {
      this.seen.set(key, recordCid);
      return undefined;
    }
    if (existing === recordCid) return undefined; // idempotent re-submission
    const [a, b] = existing < recordCid ? [existing, recordCid] : [recordCid, existing];
    return { deviceKeyId, deviceSeq, objectCidA: a, objectCidB: b };
  }
}

export interface BuildDeviceForkEvidenceParams {
  readonly observation: DeviceForkObservation;
  readonly observedAtClaimMs?: number;
  readonly observedContext?: ForkEvidenceV2['observed_context'];
}

/** Build a `fork_evidence` record for a detected device-sequence fork. */
export function buildDeviceForkEvidence(params: BuildDeviceForkEvidenceParams): ForkEvidenceV2 {
  const { observation } = params;
  return forkEvidenceV2Schema.parse({
    record_version: 2,
    kind: 'fork_evidence',
    fork_kind: 'device_sequence',
    object_cid_a: observation.objectCidA,
    object_cid_b: observation.objectCidB,
    device_key_id: observation.deviceKeyId,
    device_seq: observation.deviceSeq,
    ...(params.observedAtClaimMs !== undefined
      ? { observed_at_claim_ms: params.observedAtClaimMs }
      : {}),
    ...(params.observedContext !== undefined ? { observed_context: params.observedContext } : {}),
  });
}

/** Encode fork evidence to its deterministic LDC body. */
export function encodeForkEvidence(evidence: ForkEvidenceV2): Uint8Array {
  return encodeWithSchema(forkEvidenceV2Schema, evidence);
}
