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
}

export interface RegionResolutionDeps {
  declarations: RegionDeclarationStore;
  /** The shipped locale-subtag resolver (`RegionResolverPort` over identity). */
  localeRegion: (userId: string) => Promise<string | null>;
}

/** Resolve the strongest available basis; every failure degrades DOWN the
 *  ladder, never up (a store outage can only under-resolve). */
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
    // Fall through to the weaker rung (fail-closed direction).
  }
  try {
    const subtag = await deps.localeRegion(userId);
    if (subtag !== null) return { region: subtag, basis: 'locale_subtag' };
  } catch {
    // Fall through to unknown.
  }
  return { region: null, basis: 'unknown' };
}
