// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The per-object status type (OFFLINE_SPEC §16.11).  Every imported CID yields
// one of these, so a receiver always learns exactly what happened to each object
// (accepted, quarantined-with-missing-deps, conflicting, or rejected).

export type ObjectStatusCode =
  | 'accepted'
  | 'already_have'
  | 'stored_pending'
  | 'stored_unverified'
  | 'quarantined_missing_dependency'
  | 'quarantined_unknown_key'
  | 'quarantined_stale_checkpoint'
  | 'quarantined_policy_review'
  | 'conflict_device_fork'
  | 'rejected_bad_cid'
  | 'rejected_bad_schema'
  | 'rejected_bad_signature'
  | 'rejected_high_s_signature'
  | 'rejected_revoked'
  | 'rejected_capability_expired'
  | 'rejected_policy_denied'
  | 'rejected_quota'
  | 'rejected_resource_limit';

export interface ObjectStatusV2 {
  readonly cid: string;
  readonly cid_kind: 'record' | 'proof' | 'block' | 'chunk';
  readonly status: ObjectStatusCode;
  readonly missing_cids?: readonly string[];
  readonly detail_code?: string;
  readonly receipt_cid?: string;
}
