// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L data-rights: the DSAR export + hard-deletion of a user's FINANCIAL wallet
// footprint.  These wire the WS-L stores into the WS-D privacy lifecycle
// (`identity/privacy-jobs.ts`) so a linked wallet, its signed actions, its
// proposal signatures, and its private receipts never outlive the account.
//
// Data minimization (§19.5): the export carries the TRUNCATED display address
// only — NEVER the financial-domain address hash — mirroring the owner-facing
// wallet projection.  Reporter/counterparty identities are never included.

import type { ActionNonceStore } from './services.js';
import type {
  ComprehensionStore,
  FinancialWalletStore,
  GovernanceAuditStore,
  GovernanceProposalStore,
  GovernanceSignatureStore,
  KnomosisActionStore,
  KnomosisReceiptStore,
  ProposalVoteStore,
  SimTreasuryStore,
} from './stores.js';

export interface WalletDataRightsDeps {
  wallets: FinancialWalletStore;
  actions: KnomosisActionStore;
  proposalSignatures: GovernanceSignatureStore;
  receipts: KnomosisReceiptStore;
  // WS-L.4 simulated-governance personal rows (WS-D tombstones users, so the DB
  // ON DELETE clauses never fire — these are purged/anonymized explicitly).
  proposals: GovernanceProposalStore;
  votes: ProposalVoteStore;
  simTreasury: SimTreasuryStore;
  governanceAudit: GovernanceAuditStore;
  comprehension: ComprehensionStore;
  nonces: ActionNonceStore;
}

/** A high ceiling that covers realistic per-user receipt volume, so a DSAR
 *  export is COMPLETE rather than silently truncated (the store returns all
 *  rows up to this bound). */
const MAX_EXPORT_ROWS = 1_000_000;

/** WS-L DSAR export: the user's own wallet links (truncated) + private receipts
 *  + simulated-governance activity (proposals, votes, comprehension). */
export async function exportFinancialWalletData(
  deps: WalletDataRightsDeps,
  userId: string,
): Promise<{
  wallets: unknown[];
  receipts: unknown[];
  simulated_proposals: unknown[];
  simulated_votes: unknown[];
  comprehension: unknown[];
}> {
  const wallets = (await deps.wallets.listByUser(userId, true)).map((w) => ({
    wallet_account_id: w.walletAccountId,
    label: w.label,
    // Truncated display form ONLY — the address hash is never exported (§19.5).
    address_truncated: w.addressTruncated,
    chain_id: w.chainId,
    wallet_type: w.walletType,
    unlink_state: w.unlinkState,
    risk_state: w.riskState,
    linked_at: w.linkedAt,
    last_used_at: w.lastUsedAt,
  }));
  const receipts = (await deps.receipts.listPrivateForUser(userId, MAX_EXPORT_ROWS)).map((r) => ({
    receipt_id: r.receiptId,
    action_record_id: r.actionRecordId,
    kind: r.kind,
    final_state: r.finalState,
    // The FULL private receipt data the owner endpoint returns — the DSAR copy
    // must be complete, not metadata-only (WS-L.3.4c).
    payload: r.payload,
    summary_payload_hash: r.summaryPayloadHash,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }));
  const simulated_proposals = (await deps.proposals.listByProposer(userId)).map((p) => ({
    proposal_id: p.proposalId,
    room_id: p.roomId,
    proposal_type: p.proposalType,
    title: p.title,
    voting_state: p.votingState,
    execution_state: p.executionState,
    simulation_mode: p.simulationMode,
    created_at: p.createdAt,
  }));
  const simulated_votes = (await deps.votes.listByVoter(userId)).map((v) => ({
    proposal_id: v.proposalId,
    choice: v.choice,
    cast_at: v.castAt,
  }));
  const comprehension = (await deps.comprehension.listByUser(userId)).map((c) => ({
    quiz_version: c.quizVersion,
    passed: c.passed,
    attempts: c.attempts,
    passed_at: c.passedAt,
  }));
  return { wallets, receipts, simulated_proposals, simulated_votes, comprehension };
}

/**
 * WS-L hard deletion: purge every personal financial row for a user — private
 * receipts, signed actions, proposal signatures, and the wallet links
 * themselves.  Public receipts (no owner) are the public ledger and are left
 * intact.  Idempotent (each purge is a filtered delete).
 */
export async function purgeFinancialWalletData(
  deps: WalletDataRightsDeps,
  userId: string,
): Promise<void> {
  await deps.receipts.purgeByUser(userId);
  await deps.actions.purgeByUser(userId);
  await deps.proposalSignatures.purgeByUser(userId);
  await deps.wallets.purgeByUser(userId);
  // WS-L.4 simulated-governance personal rows: DELETE the user's OWN votes /
  // comprehension / anti-replay nonces, ANONYMIZE the proposer link on proposals
  // they authored (deleting the proposal would cascade-remove OTHER members'
  // votes/signatures via the §0059 FKs), and ANONYMIZE the append-only ledgers
  // (audit log + sim-treasury entries) — scrub the actor, keep the row.
  await deps.votes.purgeByUser(userId);
  await deps.proposals.anonymizeProposer(userId);
  await deps.comprehension.purgeByUser(userId);
  await deps.nonces.purgeByUser(userId);
  await deps.simTreasury.anonymizeActor(userId);
  await deps.governanceAudit.anonymizeActor(userId);
}
