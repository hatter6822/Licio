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

import type { CryptoFeatureCell, WalletRiskState } from '@licio/shared';

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
   * only; without the ref the engine cannot tell two transfers apart and
   * keeps the action held (fail-closed) rather than letting a cleared review
   * cover every later transfer of the same amount.
   */
  fraudRisk(args: {
    userId: string;
    actionType: string;
    amountMinorUnits: string | null;
    reviewRef?: string;
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
   */
  jurisdiction(args: {
    userId: string;
    region: string | null;
    featureCell?: CryptoFeatureCell;
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
