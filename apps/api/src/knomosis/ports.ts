// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L port seams to the workstreams this one consumes but never reimplements
// (WS-L bounded-context map): WS-N compliance (sanctions / fraud / velocity /
// jurisdiction / wallet-risk assessment) and WS-M treasury obligations.  Every
// default is FAIL-CLOSED: an absent WS-N engine answers `unavailable`/`unknown`
// — which the preflight pipeline maps to rejection for real-fund environments
// (SPEC §17.10 "unknown jurisdiction = no crypto features") — never `clear`.
//
// Region resolution follows the §19.1 doctrine: the requester's SELF-DECLARED
// account locale region (BCP-47 subtag), NEVER a network address or device
// geolocation.  Unknown region resolves to null, and every consumer treats
// null conservatively (kill switches match; real-fund jurisdiction rejects).
//
// Privacy boundary (WS-L.1.2e / WS-N.2.2d): the request shapes below carry NO
// attention, reading, or behavioral field — structurally, a screening call
// cannot leak private attention data to a chain-analytics provider.  A unit
// test asserts the field lists stay clean.

import type { CryptoFeatureCell, ReviewSubject, WalletRiskState } from '@licio/shared';

/** Sanctions screening verdict for an address (WS-N.2.2a seam). */
export type SanctionsVerdict = 'clear' | 'blocked' | 'unavailable';

/** Fraud/velocity risk verdict (WS-N.2.2b/c seam). */
export type FraudVerdict = 'normal' | 'elevated' | 'blocked' | 'unavailable';

/** Jurisdiction availability verdict (WS-N.1.1 seam). */
export type JurisdictionVerdict = 'allowed' | 'blocked' | 'unknown';

export interface WalletRiskAssessment {
  state: WalletRiskState;
  explanation: string;
  nextStep: string | null;
}

/**
 * Screen several addresses and fold the answers into ONE verdict, worst-first:
 * `blocked` if any party is listed, else `unavailable` if any answer was
 * inconclusive, else `clear`.
 *
 * Fail-closed by construction — a transfer is only as clean as its dirtiest
 * counterparty, and an address we could not screen is not an address we
 * cleared.  Lives here rather than at the two call sites so the preflight and
 * its submit re-check cannot fold them differently.
 */
export async function worstSanctionsVerdict(
  compliance: Pick<CompliancePort, 'screenAddress'>,
  addressesLower: readonly string[],
  deploymentId: string,
): Promise<SanctionsVerdict> {
  let worst: SanctionsVerdict = 'clear';
  for (const addressLower of addressesLower) {
    const verdict = await compliance.screenAddress({ addressLower, deploymentId });
    if (verdict === 'blocked') return 'blocked';
    if (verdict === 'unavailable') worst = 'unavailable';
  }
  return worst;
}

export interface CompliancePort {
  /** Screen a recipient/actor address.  Payload is the ADDRESS ONLY — no
   *  attention or behavioral fields exist on this seam (WS-L.3.1b). */
  screenAddress(args: { addressLower: string; deploymentId: string }): Promise<SanctionsVerdict>;
  /**
   * Velocity/pattern fraud risk for an action.
   *
   * `reviewRef` identifies the ONE attempted transfer being checked — the
   * preflight and submit of the same action share it (the bound typed-data
   * hash), while a different intent/nonce is a different attempt.  A
   * high-value review a compliance reviewer clears applies to THAT attempt
   * only; `null` means the caller cannot identify the attempt, so the engine
   * withholds the cleared-review exit (fail-closed) rather than let one
   * clearance cover every later transfer of the same amount.
   *
   * `reviewSubject` names WHO the review is about, which is not always the
   * caller: a disbursement from a room treasury belongs to the ROOM, not to
   * whichever steward happened to authorize it (the same rule the room-owned
   * payout intent already states about itself).  Attributing it to the actor
   * would open a separate review per steward for ONE payout, and leave that
   * review unfindable from the fraud queue — which knows the intent and its
   * room, never which steward pressed the button.  `null` = the actor is the
   * subject (a personal pay-in).  Use `reviewSubjectForAction` rather than deciding
   * per call site.
   *
   * `userId` stays the ACTOR, and it is the actor's REGION that resolves from
   * it: a room does not declare a jurisdiction, the human authorizing the
   * movement does.  The velocity window, though, follows the `reviewSubject` —
   * a room's payout stream is the room's, so per-steward buckets would hand
   * each steward a fresh window over the same stream (rotate stewards, walk
   * through the limit) and spend the steward's personal budget on the room's
   * money besides.
   *
   * All three are REQUIRED, not optional: a caller that forgets one would
   * silently take the weaker path, so the compiler makes every consumer decide
   * (see the `jurisdiction` note below).
   */
  fraudRisk(args: {
    userId: string;
    actionType: string;
    amountMinorUnits: string | null;
    reviewRef: string | null;
    reviewSubject: ReviewSubject | null;
  }): Promise<FraudVerdict>;
  /**
   * Whether crypto features are available in the user's jurisdiction.
   *
   * `featureCell` names the §22.2 policy cell the caller is about to exercise
   * (derived from the action type).  A jurisdiction policy is per-cell, so a
   * region may permit payments while disabling `governance`: WITHOUT the cell
   * the verdict can only speak for the region as a whole and a governance
   * signature would ride a payments-enabled `allowed`.  Every real signed
   * action therefore passes its cell; omitting it keeps the region-wide
   * reading (no cell claimed, so no cell-specific permission is implied).
   *
   * `asset` names the asset a fund-moving action would move.  A policy's
   * `asset_flags` are a per-region prohibition list in their own right — a
   * region can permit payments while barring a specific asset — so a
   * cell-only verdict would let a barred asset through on its cell's
   * approval.  `null` = this action moves no asset (the governance
   * signatures).
   *
   * Both are REQUIRED with nullable values, deliberately.  As optionals they
   * were forgettable, and every consumer that forgot one silently got the
   * broader verdict: three review rounds found the cell missing from a
   * different caller each time, and the asset gate missing from all of them.
   * Required-and-nullable makes the compiler ask every call site — including
   * the next one anyone writes — what it is exercising, so `null` becomes a
   * decision on the record instead of an omission nobody sees.
   */
  jurisdiction(args: {
    userId: string;
    region: string | null;
    featureCell: CryptoFeatureCell | null;
    asset: string | null;
  }): Promise<JurisdictionVerdict>;
  /** Coarse wallet risk assessment (WS-L.2.5c-1); label + safe explanation
   *  only — raw sanctions/fraud internals never cross this seam. */
  walletRisk(args: {
    walletAccountId: string;
    userId: string;
  }): Promise<WalletRiskAssessment | 'unavailable'>;
}

/** FAIL-CLOSED default: no WS-N engine ⇒ nothing screens clear. */
export const defaultCompliancePort: CompliancePort = {
  screenAddress: async () => 'unavailable',
  fraudRisk: async () => 'unavailable',
  jurisdiction: async () => 'unknown',
  walletRisk: async () => 'unavailable',
};

/** One blocking obligation surfaced by the unlink check (WS-L.2.5b). */
export interface ExternalObligation {
  type: 'pending_grant' | 'pending_payment';
  ref: string;
  description: string;
}

/** WS-M seam: pending grants / payment intents that block an unlink.  WS-L's
 *  own obligation sources (open signed actions, open proposal signatures) are
 *  computed from its stores; the boot wires the LIVE WS-M port
 *  (`buildTreasuryObligationsPort`) over the treasury container.  The empty
 *  default remains only for surfaces without a WS-M container (tests, the
 *  bare sim boot). */
export interface TreasuryObligationsPort {
  obligationsForWallet(walletAccountId: string): Promise<ExternalObligation[]>;
}

export const defaultTreasuryObligationsPort: TreasuryObligationsPort = {
  obligationsForWallet: async () => [],
};

/** §19.1-safe region resolution: the account's self-declared locale region. */
export interface RegionResolverPort {
  regionForUser(userId: string): Promise<string | null>;
}

/** Extract the BCP-47 region subtag ('en-GB' → 'GB'); null when absent. */
export function localeRegionSubtag(locale: string | null): string | null {
  if (locale === null) return null;
  const match = locale.match(/-([A-Za-z]{2})(?:-|$)/);
  return match === null ? null : (match[1]?.toUpperCase() ?? null);
}

/** Fail-closed default: no identity lookup wired ⇒ region unknown. */
export const defaultRegionResolverPort: RegionResolverPort = {
  regionForUser: async () => null,
};

/**
 * Build the production region resolver over the identity user store (the
 * SELF-DECLARED account locale — §19.1: never an address, never geolocation).
 */
export function createIdentityRegionResolver(getLocale: {
  userLocale(userId: string): Promise<string | null>;
}): RegionResolverPort {
  return {
    regionForUser: async (userId) => {
      try {
        return localeRegionSubtag(await getLocale.userLocale(userId));
      } catch {
        return null;
      }
    },
  };
}
