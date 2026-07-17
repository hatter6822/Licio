// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.5c-1 — the ONE wallet-risk read-through the preflight gate, the submit
// gate, and the owner-readable risk-state route all share.
//
// `CompliancePort.walletRisk` reports the ADVERSE posture derived from active
// pins and open cases; when it finds none it answers `normal`.  But that
// absence is EQUALLY true of a wallet that was never screened as of one screened
// `clear` — so a still-fail-closed `pending` wallet must NOT be lifted to
// `normal` here on an absence-of-signal `normal`.  Only a recorded link-time
// `clear` screening (`screenLinkedWallet`, the one moment the plaintext address
// exists) or a compliance-role action may promote a wallet out of `pending`.
//
// Escalations always apply (pending/normal/elevated → elevated/high — strictly
// more restrictive, always safe), and an `unavailable` engine leaves the stored
// state in place (fail closed).  Centralising the decision here keeps the three
// call sites from drifting into three different fail-open shapes.

import type { WalletRiskState } from '@licio/shared';
import type { CompliancePort, WalletRiskAssessment } from './ports.js';
import type { FinancialWalletStore } from './stores.js';

export interface WalletRiskReadThroughDeps {
  compliance: Pick<CompliancePort, 'walletRisk'>;
  wallets: Pick<FinancialWalletStore, 'updateRiskState'>;
}

export interface ResolvedWalletRisk {
  /** The resolved state (persisted column-scoped when it changed from stored). */
  state: WalletRiskState;
  /** The raw assessment, for the owner-readable route's explanation text. */
  assessment: WalletRiskAssessment | 'unavailable';
}

export async function resolveWalletRiskState(
  deps: WalletRiskReadThroughDeps,
  wallet: { walletAccountId: string; userId: string; riskState: WalletRiskState },
): Promise<ResolvedWalletRisk> {
  const assessment = await deps.compliance.walletRisk({
    walletAccountId: wallet.walletAccountId,
    userId: wallet.userId,
  });
  if (assessment === 'unavailable' || assessment.state === wallet.riskState) {
    return { state: wallet.riskState, assessment };
  }
  // Fail-closed (thread-Y): absence-of-signal `normal` may not lift a still-
  // unscreened `pending` wallet — that is what a link-time `clear` records, and
  // its absence here means the wallet was never certified.
  if (wallet.riskState === 'pending' && assessment.state === 'normal') {
    return { state: wallet.riskState, assessment };
  }
  // Column-scoped write — never a stale full-record snapshot that could clobber
  // a concurrent unlink (WS-L.2.5c-1).
  await deps.wallets.updateRiskState(wallet.walletAccountId, assessment.state);
  return { state: assessment.state, assessment };
}
