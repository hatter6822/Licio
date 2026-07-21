// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Governance-participation eligibility (bot-prevention layer 3, WS-U/WS-M
// platform floor).  Room governance — electing stewards, ratifying models,
// creating/voting/challenging proposals, delegating voting power — is
// reserved for accounts that hold a REVIEWER-VERIFIED KYC standing (the
// WS-N.1.1f seam that makes them capable actors on the Knomosis backend) and
// carry no compliance hold or sanctions-linked wallet.  A verified human
// costs an attacker what a verified human costs; a bot fleet cannot vote.
//
// This is a PLATFORM floor, enforced at the route boundary BEFORE the
// community-configurable §17.5 eligibility rules (law packs), and it is
// deliberately NOT law-pack-overridable — the same posture as the WS-U
// non-overridable legal floor.  Content participation (reading, posting,
// commenting) is NEVER gated here: only governance power is.
//
// Fail-closed discipline (WS-N):
//   • no compliance container            → ineligible (eligibility_unavailable)
//   • unreadable KYC standing            → 'none' → kyc_required
//   • unreadable case store              → compliance_hold (the availability
//     path's posture: an unreadable case store HOLDS)
//   • a HIGH-risk (sanctions-linked) financial wallet → wallet_risk
// The knomosis wallet leg resolves through its container; both containers are
// unconditionally constructed by the production and e2e boots.
import type { MiddlewareHandler } from 'hono';
import {
  type ComplianceServices,
  complianceServicesConfigured,
  ensureComplianceServicesForTests,
  getComplianceServices,
} from '../compliance/services.js';
import { getKnomosisServices, knomosisServicesConfigured } from '../knomosis/services.js';
import type { AuthEnv } from '../middleware/auth.js';

export interface GovernanceEligibilityDenial {
  code: 'kyc_required' | 'compliance_hold' | 'wallet_risk' | 'eligibility_unavailable';
  message: string;
}

const KYC_REQUIRED: GovernanceEligibilityDenial = {
  code: 'kyc_required',
  message:
    'Room governance requires a verified identity (KYC). Complete verification to elect stewards, ratify models, or vote on proposals.',
};

const UNAVAILABLE: GovernanceEligibilityDenial = {
  code: 'eligibility_unavailable',
  message: 'Governance eligibility cannot be established right now. Please try again shortly.',
};

function resolveCompliance(): ComplianceServices | null {
  if (complianceServicesConfigured()) return getComplianceServices();
  // TEST-ONLY: unit suites exercise governance routes without the full WS-N
  // fixture; the test bootstrap provides a real in-memory container (the single
  // source of truth for the seeded KYC standing). In PRODUCTION a missing
  // container is a boot-invariant violation — return null so the caller fails
  // closed (deny), never a `*ForTests` bootstrap on a live path.
  return process.env['NODE_ENV'] === 'test' ? ensureComplianceServicesForTests() : null;
}

/** Fail-closed denial, plus a metric so a production outage that lands on this
 *  branch is not silent (governance is a security gate). */
function unavailable(compliance: ComplianceServices | null): GovernanceEligibilityDenial {
  compliance?.metrics.increment('governance.eligibility.unavailable');
  return UNAVAILABLE;
}

/**
 * The eligibility predicate. `null` ⇔ eligible; otherwise the typed denial
 * the route returns as a 403 body (`{ error: denial }`). EVERY error/unknown
 * path denies (fail closed).
 */
export async function checkGovernanceEligibility(
  userId: string,
): Promise<GovernanceEligibilityDenial | null> {
  const compliance = resolveCompliance();
  if (compliance === null) return unavailable(null);

  // 1. KYC standing — the layer-3 bar. The default `kycLevel` closure catches
  //    internally, but a boot-swapped partner adapter might not, so wrap it too
  //    (a throwing standing is no standing → KYC_REQUIRED).
  try {
    if ((await compliance.kycLevel(userId)) !== 'kyc_partner') return KYC_REQUIRED;
  } catch {
    return KYC_REQUIRED;
  }

  // 2. Compliance hold — the same anti-tipping-off query the availability
  //    engine uses (WS-N.2.3d): suppressed lawful-access intake cases are
  //    EXCLUDED so the hold cannot reveal what counsel has not permitted the
  //    member to be told; an unreadable case store HOLDS.
  try {
    const suppressed = await compliance.lawfulAccess.unnotifiedCaseIdsForSubject(userId);
    const openCases = await compliance.cases.countOpenByRisk(
      userId,
      'user',
      ['high', 'critical'],
      suppressed,
    );
    if (openCases > 0) {
      return {
        code: 'compliance_hold',
        message:
          'Your account is under a compliance review; governance participation is paused until it completes.',
      };
    }
  } catch {
    return unavailable(compliance);
  }

  // 3. Wallet risk — a linked financial wallet in the HIGH (sanctions-linked)
  //    risk state disqualifies governance power while it stands. The knomosis
  //    container is unconditionally constructed by the production + e2e boots;
  //    a compliance-less unit fixture has none, and the KYC bar above already
  //    applied, so skip the leg there — but a PRODUCTION outage fails closed.
  if (knomosisServicesConfigured()) {
    try {
      const wallets = await getKnomosisServices().wallets.listByUser(userId, false);
      if (wallets.some((wallet) => wallet.riskState === 'high')) {
        return {
          code: 'wallet_risk',
          message:
            'A linked wallet is under a high-risk hold; governance participation is paused until it is resolved.',
        };
      }
    } catch {
      return unavailable(compliance);
    }
  } else if (process.env['NODE_ENV'] !== 'test') {
    return unavailable(compliance);
  }

  return null;
}

/**
 * Chainable route guard (the requireVerifiedAccount composition slot).
 * 401 without an auth context; 403 `{ error: denial }` when ineligible.
 */
export function requireGovernanceEligibility(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) {
      return c.json(
        { error: { code: 'unauthenticated', message: 'Authentication required' } },
        401,
      );
    }
    const denial = await checkGovernanceEligibility(auth.userId);
    if (denial) return c.json({ error: denial }, 403);
    await next();
    return;
  };
}
