// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1b — identity-free region resolution.  §19.1 is categorical: the
// application never reads the client network address (statically enforced by
// no-client-address.test.ts) and performs no geo-IP lookup of any kind —
// there is NO geolocation anywhere in this module.  Region is SELF-DECLARED,
// resolved per request from durable account state on a strongest-first
// ladder, and returned WITH its basis so the engine can require a stronger
// basis for higher tiers (real funds ⇒ verified declaration):
//
//   1. verified declaration (WS-N.1.1f; reviewer-verified) — the strongest;
//   2. the account-locale BCP-47 region subtag (the shipped
//      `RegionResolverPort` semantics) — a low-assurance basis;
//   3. `unknown` (fail-closed: all crypto features disabled).
//
// Nothing here is ever stored on the session (`sessionRecordSchema` is strict
// and location-free by design — the §19.1 amendment).
import type { RegionResolutionBasis } from '@licio/shared';
import type { RegionDeclarationStore } from './stores.js';

export interface RegionResolution {
  region: string | null;
  basis: RegionResolutionBasis;
  /** True when the region could not be RESOLVED because the declaration store
   *  read FAILED (a transient outage), as distinct from a resolved-but-unknown
   *  region (no verified declaration, no locale — the testnet-permissive case).
   *  The two are both `basis: 'unknown'`, but only the outage must fail CLOSED:
   *  a member whose verified declaration names a BLOCKED region must not slip
   *  through the wallet/real-funds gates while the store is down (thread
   *  wallet.ts:152).  The wire basis stays `unknown`; this is engine-internal. */
  unavailable?: boolean;
}

export interface RegionResolutionDeps {
  declarations: RegionDeclarationStore;
  /** The shipped locale-subtag resolver (`RegionResolverPort` over identity). */
  localeRegion: (userId: string) => Promise<string | null>;
}

/** Resolve the strongest available basis.  A failure degrades toward `unknown`
 *  (fail-closed), never toward a MORE permissive region: a declaration-read
 *  failure jumps straight to `unknown`, and a locale-read failure to `unknown`
 *  too. */
export async function resolveRegion(
  deps: RegionResolutionDeps,
  userId: string,
): Promise<RegionResolution> {
  try {
    const declaration = await deps.declarations.get(userId);
    if (
      declaration !== null &&
      declaration.status === 'verified' &&
      declaration.verificationLevel === 'reviewer_verified'
    ) {
      return { region: declaration.declaredRegion, basis: 'verified_declaration' };
    }
  } catch {
    // FAIL CLOSED, not down the ladder.  A store outage cannot be read as "no
    // verified declaration": a member whose verified declaration names a BLOCKED
    // region would otherwise fall to the weaker locale rung and resolve to a MORE
    // PERMISSIVE region — a transient outage allowing the very wallet links and
    // testnet actions the stored declaration denies.  `unknown` alone disables
    // real-funds cells, but the wallet/testnet gates pass an ordinary `unknown`
    // (no region ⇒ testnet posture) — so this path ALSO marks `unavailable`, and
    // the engine fails those affordances closed while the store is down.  A
    // successful read that finds no verified declaration still falls to locale
    // below, because then we KNOW there is nothing stronger to lose.
    return { region: null, basis: 'unknown', unavailable: true };
  }
  try {
    const subtag = await deps.localeRegion(userId);
    if (subtag !== null) return { region: subtag, basis: 'locale_subtag' };
  } catch {
    // Fall through to unknown.
  }
  return { region: null, basis: 'unknown' };
}
