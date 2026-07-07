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

import type {
  FinancialWalletStore,
  GovernanceSignatureStore,
  KnomosisActionStore,
  KnomosisReceiptStore,
} from './stores.js';

export interface WalletDataRightsDeps {
  wallets: FinancialWalletStore;
  actions: KnomosisActionStore;
  proposalSignatures: GovernanceSignatureStore;
  receipts: KnomosisReceiptStore;
}

/** Cap the private receipts pulled into a single DSAR export archive. */
const MAX_EXPORT_RECEIPTS = 1000;

/** WS-L DSAR export: the user's own wallet links (truncated) + private receipts. */
export async function exportFinancialWalletData(
  deps: WalletDataRightsDeps,
  userId: string,
): Promise<{ wallets: unknown[]; receipts: unknown[] }> {
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
  const receipts = (await deps.receipts.listPrivateForUser(userId, MAX_EXPORT_RECEIPTS)).map(
    (r) => ({
      receipt_id: r.receiptId,
      action_record_id: r.actionRecordId,
      kind: r.kind,
      final_state: r.finalState,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }),
  );
  return { wallets, receipts };
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
}
