// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §18.2 trust states and their lattice (WS-R.8.1).  A record's state is the
// least upper bound of its discharged facts along the positive ladder
// (raw_unverified → … → witnessed); the override states (conflicting / revoked /
// rejected) take absolute precedence.  `stale_authorized` is a distinct sibling
// of `authorized_provisional` for when the revocation/checkpoint frontier is
// behind.  The UI MUST NOT collapse these into one "verified" badge (§18.2).

/** The §18.2 trust states. */
export type TrustState =
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

/** States on the monotone positive ladder (override states excluded). */
export type PositiveState = Exclude<TrustState, 'conflicting' | 'revoked' | 'rejected'>;

/**
 * The rank of each positive state.  `stale_authorized` shares
 * `authorized_provisional`'s rank: it is the same height with a staleness
 * modifier, and is superseded once a higher fact (server/checkpoint/witness)
 * pins the record.
 */
const POSITIVE_RANK: Readonly<Record<PositiveState, number>> = {
  raw_unverified: 0,
  integrity_verified: 1,
  proof_verified: 2,
  authorized_provisional: 3,
  stale_authorized: 3,
  server_stored: 4,
  server_accepted: 5,
  checkpointed: 6,
  witnessed: 7,
};

/**
 * The higher of two positive states.  Never downgrades, and preserves a
 * `stale_authorized` already reached at rank 3 (a tie does not replace it with
 * the plain `authorized_provisional`).
 */
export function maxPositive(current: PositiveState, candidate: PositiveState): PositiveState {
  return POSITIVE_RANK[candidate] > POSITIVE_RANK[current] ? candidate : current;
}
