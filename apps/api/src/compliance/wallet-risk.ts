// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.2e — the production `CompliancePort.walletRisk` implementation.
// The shipped substrate already enforces the state machine (fail-closed
// `pending` at link; preflight/submit reject fund transfers from `high` OR
// `pending` wallets; the read-through persists resolved states); this module
// supplies the ASSESSMENT behind it.
//
// Inputs are transaction-derived ONLY (WS-N.2.2d): active pins (the WS-N.2.3b
// compromise response — a pin dominates everything and survives
// re-assessment until a compliance-role release), and the user's open
// case posture (critical ⇒ high, high ⇒ elevated).  The wallet's ADDRESS is
// deliberately not an input here: WS-D stores financial addresses only as
// keyed hashes, so address screening happens where the plaintext exists —
// at link time and per signed action (WS-N.2.2a) — and lands here as pins
// and cases.  The port returns the coarse state + a safe explanation; raw
// screening/fraud internals never cross the seam (the shipped contract).
import type { CompliancePort, WalletRiskAssessment } from '../knomosis/ports.js';
import type { ComplianceCaseStore, WalletRiskPinStore } from './stores.js';

export interface WalletRiskDeps {
  pins: WalletRiskPinStore;
  cases: ComplianceCaseStore;
  metric: (name: string) => void;
}

const EXPLANATIONS: Record<'normal' | 'elevated' | 'high', WalletRiskAssessment> = {
  normal: {
    state: 'normal',
    explanation: 'No elevated risk signals are associated with this wallet.',
    nextStep: null,
  },
  elevated: {
    state: 'elevated',
    explanation:
      'Some activity associated with this account requires additional review. Certain actions may need extra verification.',
    nextStep: 'Additional verification may be required before high-value transfers.',
  },
  high: {
    state: 'high',
    explanation: 'This wallet is currently restricted from financial actions pending review.',
    nextStep: 'Contact support to resolve the restriction.',
  },
};

export function createWalletRisk(deps: WalletRiskDeps): CompliancePort['walletRisk'] {
  return async ({ walletAccountId, userId }): Promise<WalletRiskAssessment | 'unavailable'> => {
    try {
      const pin = await deps.pins.activeForWallet(walletAccountId);
      if (pin !== null) {
        deps.metric('compliance.wallet_risk.pinned_high');
        return EXPLANATIONS.high;
      }
      // Ask the store, do not page a list: a capped `listBySubject` would miss
      // an older critical case beyond the page and hand a sanctioned wallet
      // `elevated` — and only `high` stops a fund transfer.
      const critical = await deps.cases.countOpenByRisk(userId, ['critical']);
      if (critical > 0) {
        deps.metric('compliance.wallet_risk.case_derived');
        return EXPLANATIONS.high;
      }
      const high = await deps.cases.countOpenByRisk(userId, ['high']);
      if (high > 0) {
        deps.metric('compliance.wallet_risk.case_derived');
        return EXPLANATIONS.elevated;
      }
      deps.metric('compliance.wallet_risk.normal');
      return EXPLANATIONS.normal;
    } catch {
      // A store outage leaves the stored state in place (the shipped
      // read-through treats 'unavailable' as keep-current — fail-closed:
      // a still-`pending` wallet cannot move funds).
      deps.metric('compliance.wallet_risk.unavailable');
      return 'unavailable';
    }
  };
}
