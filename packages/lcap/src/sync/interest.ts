// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Interest descriptors + privacy scoping (OFFLINE_SPEC §16.6, §26.1, WS-R.6.3).
// A client MUST NOT expose private or sensitive room interests to arbitrary
// peers/relays.  Over authenticated HTTPS to the Licio API an interest MAY carry
// a clear `room_id`; to peers/relays it must use hashed/opaque room hints only,
// and a `private` interest is NEVER leaked to an unknown peer.  `privacy_level`
// gates which audiences an interest may reach at all.  Pure functions + one
// fail-closed guard.

import type { InterestDescriptorV2 } from '../schemas/sync.js';

/** The counterparty an interest would be sent to, in increasing untrustedness. */
export type InterestAudience =
  | 'authenticated_https'
  | 'trusted_peer'
  | 'unknown_peer'
  | 'relay'
  | 'manual';

/** Audiences each `privacy_level` permits (§26.1). */
const ALLOWED_AUDIENCES: Readonly<
  Record<InterestDescriptorV2['privacy_level'], ReadonlySet<InterestAudience>>
> = {
  public: new Set<InterestAudience>([
    'authenticated_https',
    'trusted_peer',
    'unknown_peer',
    'relay',
    'manual',
  ]),
  trusted_peer_only: new Set<InterestAudience>(['authenticated_https', 'trusted_peer', 'manual']),
  manual_only: new Set<InterestAudience>(['authenticated_https', 'manual']),
};

/** Audiences that may only ever see hashed/opaque room hints (never a clear id). */
const OPAQUE_ONLY_AUDIENCES: ReadonlySet<InterestAudience> = new Set<InterestAudience>([
  'trusted_peer',
  'unknown_peer',
  'relay',
]);

/** Audiences to which a `private`-scope interest must never be exposed (§26.1). */
const PRIVATE_FORBIDDEN_AUDIENCES: ReadonlySet<InterestAudience> = new Set<InterestAudience>([
  'unknown_peer',
  'relay',
]);

/** True iff the interest's `privacy_level` permits this audience to see it at all. */
export function interestAllowedForAudience(
  interest: InterestDescriptorV2,
  audience: InterestAudience,
): boolean {
  return ALLOWED_AUDIENCES[interest.privacy_level].has(audience);
}

/** Thrown when an interest would leak private/clear room metadata to a peer. */
export class PeerInterestLeakError extends Error {
  override readonly name = 'PeerInterestLeakError';
  constructor(reason: string) {
    super(`interest would leak to an untrusted audience: ${reason}`);
  }
}

/**
 * Fail-closed guard: throw if `interest` cannot be safely sent to `audience` —
 * the privacy level forbids the audience, a `private` scope would reach a peer,
 * or a clear `room_id` would be exposed to an opaque-only audience with no
 * hashed hint to fall back on.  This is the static check that forbids
 * constructing a peer-facing interest from a private room id (§26.1 acceptance).
 */
export function assertInterestSafeForAudience(
  interest: InterestDescriptorV2,
  audience: InterestAudience,
): void {
  if (!interestAllowedForAudience(interest, audience)) {
    throw new PeerInterestLeakError(`privacy_level ${interest.privacy_level} forbids ${audience}`);
  }
  if (interest.visibility_scope === 'private' && PRIVATE_FORBIDDEN_AUDIENCES.has(audience)) {
    throw new PeerInterestLeakError(`private scope to ${audience}`);
  }
  if (
    OPAQUE_ONLY_AUDIENCES.has(audience) &&
    interest.room_id !== undefined &&
    interest.room_id_hash === undefined
  ) {
    throw new PeerInterestLeakError(`clear room_id to ${audience} without a hashed hint`);
  }
}

/**
 * Scope an interest for an audience (§16.6, §26.1).  For authenticated HTTPS the
 * interest is returned unchanged (a clear `room_id` is allowed).  For any
 * peer/relay audience the clear `room_id` is stripped (the hashed hint, if any,
 * remains); the guard runs first, so a `private` interest to an unknown peer
 * throws rather than being silently downgraded.
 */
export function scopeInterestForAudience(
  interest: InterestDescriptorV2,
  audience: InterestAudience,
): InterestDescriptorV2 {
  assertInterestSafeForAudience(interest, audience);
  if (!OPAQUE_ONLY_AUDIENCES.has(audience)) return interest;
  if (interest.room_id === undefined) return interest;
  // Strip the clear room id; only the opaque hint may travel to a peer/relay.
  const { room_id: _omit, ...rest } = interest;
  return rest;
}
