// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.1 — the §34 honest trust/liveness label mapping.  Maps a record's trust
// state (§18.2) + liveness state (§20.1) to exactly ONE honest label that never
// overclaims: there is no single "secure"/"trusted"/"delivered"/"final"/"safe" badge
// that collapses distinct states.  Hard verdicts (rejected/revoked/conflict/stale/
// can't-verify) take precedence and cap any propagation claim; an otherwise-positive
// record is labeled by the FURTHEST propagation either signal has honestly observed.
//
// The state unions mirror `@licio/lcap` (`validate/states.ts`, `liveness/states.ts`)
// locally — apps/web does not depend on `@licio/lcap` (the workspace boundary +
// bundle leanness, the WS-R.11 client-store pattern).  A drift here is caught by the
// completeness test (every state is covered) + review against the canonical unions.

/** §18.2 trust state (mirror of `@licio/lcap` `TrustState`). */
export type LcapTrustState =
  | 'raw_unverified'
  | 'integrity_verified'
  | 'proof_verified'
  | 'authorized_provisional'
  | 'stale_authorized'
  | 'server_stored'
  | 'server_accepted'
  | 'checkpointed'
  | 'witnessed'
  | 'conflicting'
  | 'revoked'
  | 'rejected';

/** §20.1 liveness state (mirror of `@licio/lcap` `LivenessState`). */
export type LcapLivenessState =
  | 'local_created'
  | 'local_signed'
  | 'queued'
  | 'packed'
  | 'exported'
  | 'peer_stored'
  | 'relay_stored'
  | 'server_stored'
  | 'server_accepted'
  | 'checkpointed'
  | 'witnessed';

/** The 13 §34 honest labels (i18n catalog keys; the rendered text lives in the catalog). */
export type TrustLabelKey =
  | 'saved_on_device'
  | 'queued_for_sync'
  | 'shared_in_export'
  | 'stored_by_relay'
  | 'received_by_server'
  | 'accepted_by_room'
  | 'included_in_checkpoint'
  | 'witnessed_by_watcher'
  | 'verified_local_stale_checkpoint'
  | 'cannot_verify_missing_key'
  | 'conflict_detected'
  | 'revoked'
  | 'rejected_by_room';

/** The visual tone — drives styling only; it never collapses the label's meaning. */
export type TrustTone = 'neutral' | 'progress' | 'positive' | 'caution' | 'danger';

export interface HonestLabel {
  readonly key: TrustLabelKey;
  readonly tone: TrustTone;
}

/** The tone for each honest label (uncertain → caution, hard-negative → danger). */
export const TRUST_LABEL_TONE: Readonly<Record<TrustLabelKey, TrustTone>> = {
  saved_on_device: 'neutral',
  queued_for_sync: 'progress',
  shared_in_export: 'progress',
  stored_by_relay: 'progress',
  received_by_server: 'progress',
  accepted_by_room: 'positive',
  included_in_checkpoint: 'positive',
  witnessed_by_watcher: 'positive',
  verified_local_stale_checkpoint: 'caution',
  cannot_verify_missing_key: 'caution',
  conflict_detected: 'danger',
  revoked: 'danger',
  rejected_by_room: 'danger',
};

/** Every honest-label key (the catalog + completeness pin). */
export const TRUST_LABEL_KEYS = Object.keys(TRUST_LABEL_TONE) as readonly TrustLabelKey[];

function labelKey(trust: LcapTrustState, liveness: LcapLivenessState): TrustLabelKey {
  // 1) Hard verdicts cap everything (§18.2): never show propagation for these.
  if (trust === 'rejected') return 'rejected_by_room';
  if (trust === 'revoked') return 'revoked';
  if (trust === 'conflicting') return 'conflict_detected';
  if (trust === 'raw_unverified' || trust === 'integrity_verified') {
    return 'cannot_verify_missing_key'; // CID/integrity only, no authorized proof chain yet
  }
  if (trust === 'stale_authorized') return 'verified_local_stale_checkpoint';

  // 2) Positive (proof_verified / authorized_provisional+): the furthest honest reach,
  // taking whichever of the trust or liveness signal has observed the most.
  if (trust === 'witnessed' || liveness === 'witnessed') return 'witnessed_by_watcher';
  if (trust === 'checkpointed' || liveness === 'checkpointed') return 'included_in_checkpoint';
  if (trust === 'server_accepted' || liveness === 'server_accepted') return 'accepted_by_room';
  if (trust === 'server_stored' || liveness === 'server_stored') return 'received_by_server';
  if (liveness === 'relay_stored' || liveness === 'peer_stored') return 'stored_by_relay';
  if (liveness === 'exported') return 'shared_in_export';
  if (liveness === 'queued' || liveness === 'packed') return 'queued_for_sync';
  return 'saved_on_device';
}

/**
 * The single honest label for a record's `(trust, liveness)` pair (§34).  Hard/
 * uncertain trust states win; an authorized record is labeled by the furthest
 * propagation either signal has honestly observed.
 */
export function honestTrustLabel(trust: LcapTrustState, liveness: LcapLivenessState): HonestLabel {
  const key = labelKey(trust, liveness);
  return { key, tone: TRUST_LABEL_TONE[key] };
}
