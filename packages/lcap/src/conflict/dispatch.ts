// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conflict-table dispatch (OFFLINE_SPEC §25.1, WS-R.13.1).  Routes a validation
// outcome + fork signals to the documented §25.1 action and status: a
// bad-signature body is kept only as untrusted FORENSIC material (never
// rendered); fork / checkpoint-fork always gossip evidence and never silently
// drop data; missing deps quarantine (retriable); revoked is marked and never
// rendered trusted.  Every situation yields an explicit outcome — nothing is
// discarded silently.

import type { ObjectStatusCode } from '../pack/status.js';
import type { ValidationResult } from '../validate/validate.js';

export type ConflictAction = 'accept' | 'reject' | 'quarantine' | 'revoked' | 'conflicting';

export interface ConflictOutcome {
  readonly action: ConflictAction;
  readonly status: ObjectStatusCode;
  /** Keep the body as untrusted forensic material (bad signature). */
  readonly keepForensic?: boolean;
  /** Create + gossip fork evidence (device / checkpoint fork). */
  readonly gossipForkEvidence?: boolean;
  /** A severe consistency warning (checkpoint fork). */
  readonly severe?: boolean;
  readonly missingCids?: readonly string[];
}

export interface ConflictSituation {
  readonly validation: ValidationResult;
  readonly deviceForkDetected?: boolean;
  readonly checkpointForkDetected?: boolean;
  /** Room policy for an expired capability (§25.1: reject OR quarantine). */
  readonly capabilityExpiredPolicy?: 'reject' | 'quarantine';
}

/** Dispatch a conflict situation to its §25.1 outcome. */
export function dispatchConflict(situation: ConflictSituation): ConflictOutcome {
  const { validation } = situation;

  // Fork classes override everything — always gossip, never silently drop.
  if (situation.checkpointForkDetected) {
    return {
      action: 'conflicting',
      status: 'conflict_device_fork',
      gossipForkEvidence: true,
      severe: true,
    };
  }
  if (situation.deviceForkDetected || validation.conflict === 'device_fork') {
    return { action: 'conflicting', status: 'conflict_device_fork', gossipForkEvidence: true };
  }
  if (validation.conflict === 'checkpoint_fork') {
    return {
      action: 'conflicting',
      status: 'conflict_device_fork',
      gossipForkEvidence: true,
      severe: true,
    };
  }

  switch (validation.state) {
    case 'revoked':
      return { action: 'revoked', status: 'rejected_revoked' };
    case 'conflicting':
      return { action: 'conflicting', status: 'conflict_device_fork', gossipForkEvidence: true };
    case 'rejected': {
      const code = validation.rejection ?? 'rejected_bad_schema';
      if (code === 'rejected_bad_signature' || code === 'rejected_high_s_signature') {
        // Keep the body only as untrusted forensic material; never render it.
        return { action: 'reject', status: code, keepForensic: true };
      }
      if (code === 'rejected_capability_expired') {
        return situation.capabilityExpiredPolicy === 'quarantine'
          ? { action: 'quarantine', status: 'quarantined_policy_review' }
          : { action: 'reject', status: 'rejected_capability_expired' };
      }
      return { action: 'reject', status: code };
    }
    default: {
      // integrity_verified / proof_verified with unmet dependencies → quarantine.
      if (validation.missingCids.length > 0) {
        return {
          action: 'quarantine',
          status: 'quarantined_missing_dependency',
          missingCids: validation.missingCids,
        };
      }
      return { action: 'accept', status: 'accepted' };
    }
  }
}
