// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.4 — the public-gateway rejection runtime guard (PRIVATE_SPEC §9; OFFLINE_SPEC
// §22.7).
//
// A private-p2p CID is a CIDv1 over CIPHERTEXT under a DIFFERENT CID profile (PRIVATE_SPEC
// §9.4 CID profile); the public IPFS bridge here addresses PUBLIC LCAP blocks
// (`CIDv1(raw, sha2-256)` over plaintext, OFFLINE_SPEC §22.7).  These two planes never
// share keys or code, but a coding bug could route a private CID through the public-block
// publish path; PRIVATE_SPEC §9.5 (Public IPFS avoidance) is emphatic:
//
//   "The client MUST reject any private-room render path that attempts to construct a
//    public gateway URL."  …  Private CIDs "MUST NOT be announced to public routing
//    systems or logged server-side."
//
// This guard is DEFENSE-IN-DEPTH alongside `decideBlockPublish`: even if the visibility
// gate were bypassed, no private content reaches the public DHT.  It is deliberately
// CONSERVATIVE / fail-closed — it refuses on ANY of: non-public visibility, ciphertext,
// an in-force takedown, or a CID explicitly flagged as belonging to a private room.  The
// guard cannot itself parse the private CID profile (that lives in `@licio/private-p2p`,
// which this package must NOT import — workspace-boundary gate), so the caller supplies
// the `privateRoomCid` signal; the conservative default is "treat unknown as unsafe is the
// caller's job", and any positive private signal here is an immediate refusal.

import type { BlockVisibility } from './bridge.js';

/** Why a candidate is INELIGIBLE for the public gateway/DHT (empty when eligible). */
export type PublicGatewayRejectReason =
  | 'not_public'
  | 'encrypted'
  | 'taken_down'
  | 'private_room_cid';

/** The signals the guard evaluates before any public-gateway egress. */
export interface PublicGatewayEligibilityInput {
  readonly visibility: BlockVisibility;
  /** Whether the block payload is ciphertext (private-room content). */
  readonly encrypted: boolean;
  /** Whether a WS-J takedown is in force for this block's source. */
  readonly takenDown: boolean;
  /**
   * Whether this CID is known to belong to a private room (a private-CID-profile address,
   * a private-room hint, etc.).  The caller establishes this from the room/visibility
   * model; the guard never trusts the absence of this flag to mean "definitely public".
   */
  readonly privateRoomCid: boolean;
}

/** The guard verdict.  `eligible` is true only when EVERY signal clears. */
export interface PublicGatewayEligibility {
  readonly eligible: boolean;
  readonly reason: '' | PublicGatewayRejectReason;
}

/**
 * Fail-closed eligibility for public-gateway/DHT egress.  Refuses (with the precise,
 * auditable reason) on ANY disqualifying signal; only an unambiguously public,
 * unencrypted, non-taken-down, non-private-room block is `eligible`.
 *
 * Order of checks is deterministic so the reason is stable: the strongest confidentiality
 * signals first (private-room CID, ciphertext), then visibility, then takedown.
 */
export function assertPublicGatewayEligible(
  input: PublicGatewayEligibilityInput,
): PublicGatewayEligibility {
  if (input.privateRoomCid) return { eligible: false, reason: 'private_room_cid' };
  if (input.encrypted) return { eligible: false, reason: 'encrypted' };
  if (input.visibility !== 'public') return { eligible: false, reason: 'not_public' };
  if (input.takenDown) return { eligible: false, reason: 'taken_down' };
  return { eligible: true, reason: '' };
}
