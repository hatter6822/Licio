// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.3a + WS-L.2.5a-d — the financial wallet-link service: SIWE nonce
// issue, link (EIP-4361 verification → WalletAccount), list/label, the
// obligation-checked unlink lifecycle with cooling-off, abuse limits, and the
// fail-closed risk state.
//
// Data minimization (§19.5): the full address exists only transiently during
// verification; at rest it is the FINANCIAL-domain HMAC (`address_hash`) plus
// the first-6+last-4 truncation.  Audit entries carry the truncation only.
// The financial HMAC domain is distinct from the auth-wallet domain, so
// signing in with a wallet can never be correlated with a linked financial
// wallet across contexts.

import type { UnlinkObligation, WalletRiskState, WalletSummary } from '@licio/shared';
import type { AuditStore } from '../identity/audit.js';
import type { EphemeralStore } from '../identity/ephemeral-store.js';
import {
  type ContractSignatureVerifier,
  hashFinancialWalletAddress,
  issueSiweNonce,
  type SiweConfig,
  verifySiwe,
} from '../identity/siwe.js';
import type { KnomosisRuntimeConfig } from './config.js';
import type { CompliancePort, TreasuryObligationsPort } from './ports.js';
import type {
  FinancialWalletRecord,
  FinancialWalletStore,
  GovernanceSignatureStore,
  KnomosisActionStore,
  WalletAbuseLimiter,
} from './stores.js';

const NONCE_PREFIX = 'finwallet';

export interface WalletServiceDeps {
  wallets: FinancialWalletStore;
  actions: KnomosisActionStore;
  proposalSignatures: GovernanceSignatureStore;
  compliance: CompliancePort;
  treasuryObligations: TreasuryObligationsPort;
  /** Identity TTL'd single-use store (SIWE nonces). */
  ephemeral: EphemeralStore;
  audit: AuditStore;
  abuse: WalletAbuseLimiter;
  masterSecret: string;
  /** Canonical origin binding shared with the auth SIWE config (§25.5). */
  siweBase: Pick<SiweConfig, 'domain' | 'uri'>;
  /** Chain ids of the pinned, active deployments (fail-closed allowlist). */
  chainAllowlist: () => readonly number[];
  contractVerifier?: ContractSignatureVerifier | undefined;
  config: () => KnomosisRuntimeConfig;
  now: () => number;
  uuid: () => string;
  log: (event: string, meta: Record<string, unknown>) => void;
  /** Integrity alert sink (WS-L.2.5d excessive-activity escalation). */
  alert: (event: string, meta: Record<string, unknown>) => void;
}

export type WalletServiceError = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 429;
  code: string;
  message: string;
};
const err = (
  status: WalletServiceError['status'],
  code: string,
  message: string,
): WalletServiceError => ({ ok: false, status, code, message });

const nonceKey = (tokenHash: string): string => `${NONCE_PREFIX}:${tokenHash}`;

/** Owner-facing projection with the "Wallet N" label default (WS-L.2.5c). */
export function toWalletSummary(record: FinancialWalletRecord, ordinal: number): WalletSummary {
  return {
    wallet_account_id: record.walletAccountId,
    label: record.label ?? `Wallet ${ordinal}`,
    address_truncated: record.addressTruncated,
    chain_id: record.chainId,
    wallet_type: record.walletType,
    unlink_state: record.unlinkState,
    risk_state: record.riskState,
    linked_at: record.linkedAt,
    last_used_at: record.lastUsedAt,
  };
}

/** WS-L.2.3a — issue the session-bound, single-use SIWE link nonce. */
export async function issueWalletLinkNonce(
  deps: WalletServiceDeps,
  args: { userId: string; sessionTokenHash: string },
): Promise<{ ok: true; nonce: string; issuedAt: string; expiresAt: string } | WalletServiceError> {
  const config = deps.config();
  if (!deps.abuse.hit(`nonce:${args.userId}`, config.linkAttemptsPerHour, 3_600_000)) {
    return err(429, 'rate_limited', 'Too many wallet link attempts; try again later.');
  }
  const issued = await issueSiweNonce(
    deps.ephemeral,
    nonceKey(args.sessionTokenHash),
    { nonceTtlMs: config.siweNonceTtlMs },
    deps.now(),
  );
  return {
    ok: true,
    nonce: issued.nonce,
    issuedAt: issued.issuedAt,
    expiresAt: new Date(deps.now() + config.siweNonceTtlMs).toISOString(),
  };
}

export interface LinkWalletResult {
  ok: true;
  wallet: FinancialWalletRecord;
  alreadyLinked: boolean;
}

/** WS-L.2.5a — verify SIWE and create/reactivate the WalletAccount. */
export async function linkWallet(
  deps: WalletServiceDeps,
  args: {
    userId: string;
    sessionTokenHash: string;
    message: string;
    signature: string;
    label?: string | undefined;
  },
): Promise<LinkWalletResult | WalletServiceError> {
  const config = deps.config();
  const nowMs = deps.now();

  // Abuse limit counts ATTEMPTS (including failures), per account (WS-L.2.5d).
  if (!deps.abuse.hit(`link:${args.userId}`, config.linkAttemptsPerHour, 3_600_000)) {
    deps.alert('knomosis.wallet.link_rate_exceeded', { user_id: args.userId });
    return err(429, 'rate_limited', 'Too many wallet link attempts; try again later.');
  }

  const siweConfig: SiweConfig = {
    domain: deps.siweBase.domain,
    uri: deps.siweBase.uri,
    chainAllowlist: deps.chainAllowlist(),
    nonceTtlMs: config.siweNonceTtlMs,
    maxClockSkewMs: config.siweClockSkewMs,
  };
  const verified = await verifySiwe({
    store: deps.ephemeral,
    attemptId: nonceKey(args.sessionTokenHash),
    message: args.message,
    signature: args.signature,
    config: siweConfig,
    now: nowMs,
    ...(deps.contractVerifier ? { contractVerifier: deps.contractVerifier } : {}),
  });
  if (!verified.ok) {
    deps.log('knomosis.wallet.link_rejected', { reason: verified.reason });
    return err(401, `siwe_${verified.reason}`, 'Wallet signature verification failed.');
  }

  const addressHashHex = hashFinancialWalletAddress(deps.masterSecret, verified.addressLower);
  const existing = await deps.wallets.getByAddressHash(addressHashHex);
  const nowIso = new Date(nowMs).toISOString();

  if (existing !== null) {
    if (existing.userId !== args.userId) {
      // No enumeration oracle: the caller learns only that the link failed.
      return err(409, 'address_unavailable', 'This wallet cannot be linked to this account.');
    }
    if (existing.unlinkState === 'finalized') {
      // WS-L.2.5d re-link cooldown, keyed off the finalization time.
      const cooldownMs = config.relinkCooldownDays * 86_400_000;
      const unlinkedAt = existing.unlinkedAt !== null ? Date.parse(existing.unlinkedAt) : 0;
      if (nowMs - unlinkedAt < cooldownMs) {
        return err(
          429,
          'relink_cooldown',
          'This wallet was recently unlinked; it can be re-linked after the cooldown.',
        );
      }
      const reactivated = await deps.wallets.update({
        ...existing,
        unlinkState: 'active',
        riskState: 'pending', // fail-closed: reassess on re-link
        linkedAt: nowIso,
        unlinkRequestedAt: null,
        unlinkFinalizeAfter: null,
        unlinkedAt: null,
        ...(args.label !== undefined ? { label: args.label } : {}),
      });
      await deps.audit.append({
        actorUserId: args.userId,
        eventType: 'wallet_link',
        targetRef: reactivated.addressTruncated,
        context: { setting: 'relink' },
      });
      return { ok: true, wallet: reactivated, alreadyLinked: false };
    }
    // active or pending_unlink: idempotent re-link; a pending unlink is
    // CANCELLED by re-linking during the cooling-off window (WS-L.2.5b).
    const record =
      existing.unlinkState === 'pending_unlink'
        ? await deps.wallets.update({
            ...existing,
            unlinkState: 'active',
            unlinkRequestedAt: null,
            unlinkFinalizeAfter: null,
          })
        : existing;
    return { ok: true, wallet: record, alreadyLinked: true };
  }

  const activeCount = (await deps.wallets.listByUser(args.userId, false)).length;
  if (activeCount >= config.maxWalletsPerUser) {
    return err(429, 'wallet_limit', `You can link at most ${config.maxWalletsPerUser} wallets.`);
  }

  const record: FinancialWalletRecord = {
    walletAccountId: deps.uuid(),
    userId: args.userId,
    addressHashHex,
    addressTruncated: verified.addressTruncated,
    chainId: verified.chainId,
    walletType: verified.walletType,
    unlinkState: 'active',
    riskState: 'pending', // fail-closed until first WS-N assessment
    label: args.label ?? null,
    linkedAt: nowIso,
    lastUsedAt: null,
    unlinkRequestedAt: null,
    unlinkFinalizeAfter: null,
    unlinkedAt: null,
  };
  const inserted = await deps.wallets.insert(record);
  await deps.audit.append({
    actorUserId: args.userId,
    eventType: 'wallet_link',
    // The truncation only — never the full address (§19.5).
    targetRef: inserted.addressTruncated,
    context: { setting: 'link' },
  });
  deps.log('knomosis.wallet.linked', { chain_id: inserted.chainId, type: inserted.walletType });
  return { ok: true, wallet: inserted, alreadyLinked: false };
}

/** WS-L.2.5c — the owner's wallet list with "Wallet N" label defaults. */
export async function listWallets(
  deps: WalletServiceDeps,
  args: { userId: string; includeUnlinked: boolean },
): Promise<WalletSummary[]> {
  const rows = await deps.wallets.listByUser(args.userId, args.includeUnlinked);
  return rows.map((row, index) => toWalletSummary(row, index + 1));
}

/** PATCH label (WS-L.2.5c); 404-over-403 for non-owned wallets. */
export async function setWalletLabel(
  deps: WalletServiceDeps,
  args: { userId: string; walletAccountId: string; label: string },
): Promise<{ ok: true; wallet: FinancialWalletRecord } | WalletServiceError> {
  const wallet = await deps.wallets.getById(args.walletAccountId);
  if (wallet === null || wallet.userId !== args.userId) {
    return err(404, 'not_found', 'Resource not found');
  }
  const updated = await deps.wallets.update({ ...wallet, label: args.label });
  await deps.audit.append({
    actorUserId: args.userId,
    eventType: 'wallet_label_change',
    targetRef: wallet.addressTruncated,
    context: { setting: 'label' },
  });
  return { ok: true, wallet: updated };
}

/** Map an open signed action to its blocking-obligation description. */
function actionObligation(actionType: string, ref: string): UnlinkObligation {
  const isProposalish =
    actionType === 'proposal_sign' ||
    actionType === 'charter_update' ||
    actionType === 'steward_rotation';
  return {
    type: isProposalish ? 'active_proposal' : 'pending_payment',
    ref,
    description: isProposalish
      ? 'A governance action signed by this wallet has not reached a final state.'
      : 'A payment action signed by this wallet has not reached a final state.',
  };
}

export type UnlinkRequestOutcome =
  | { ok: true; wallet: FinancialWalletRecord; finalizeAfter: string }
  | { ok: false; blocked: true; obligations: UnlinkObligation[] }
  | WalletServiceError;

/** WS-L.2.5b — obligation-checked unlink request with cooling-off. */
export async function requestUnlink(
  deps: WalletServiceDeps,
  args: { userId: string; walletAccountId: string },
): Promise<UnlinkRequestOutcome> {
  const config = deps.config();
  if (!deps.abuse.hit(`unlink:${args.userId}`, config.unlinkRequestsPerDay, 86_400_000)) {
    deps.alert('knomosis.wallet.unlink_rate_exceeded', { user_id: args.userId });
    return err(429, 'rate_limited', 'Too many unlink requests; try again later.');
  }

  const wallet = await deps.wallets.getById(args.walletAccountId);
  if (wallet === null || wallet.userId !== args.userId) {
    return err(404, 'not_found', 'Resource not found');
  }
  if (wallet.unlinkState === 'finalized') {
    return err(409, 'already_unlinked', 'This wallet is already unlinked.');
  }
  if (wallet.unlinkState === 'pending_unlink' && wallet.unlinkFinalizeAfter !== null) {
    return { ok: true, wallet, finalizeAfter: wallet.unlinkFinalizeAfter };
  }

  // WS-L.2.5b obligation check: every obligation type, each with a specific
  // description.  Fail closed: any open item blocks.
  const obligations: UnlinkObligation[] = [];
  for (const action of await deps.actions.listOpenByWallet(wallet.walletAccountId)) {
    obligations.push(actionObligation(action.actionType, action.actionRecordId));
  }
  for (const signature of await deps.proposalSignatures.listOpenByWallet(wallet.walletAccountId)) {
    obligations.push({
      type: 'active_proposal',
      ref: signature.proposalId,
      description: 'This wallet signed a governance proposal whose vote is still open.',
    });
  }
  for (const external of await deps.treasuryObligations.obligationsForWallet(
    wallet.walletAccountId,
  )) {
    obligations.push({
      type: external.type === 'pending_grant' ? 'pending_grant' : 'pending_payment',
      ref: external.ref,
      description: external.description,
    });
  }
  if (obligations.length > 0) {
    return { ok: false, blocked: true, obligations };
  }

  const nowMs = deps.now();
  const finalizeAfter = new Date(nowMs + config.unlinkCoolingOffHours * 3_600_000).toISOString();
  const updated = await deps.wallets.update({
    ...wallet,
    unlinkState: 'pending_unlink',
    unlinkRequestedAt: new Date(nowMs).toISOString(),
    unlinkFinalizeAfter: finalizeAfter,
  });
  await deps.audit.append({
    actorUserId: args.userId,
    eventType: 'wallet_unlink',
    targetRef: wallet.addressTruncated,
    context: { setting: 'request' },
  });
  return { ok: true, wallet: updated, finalizeAfter };
}

/** Scheduler sweep: finalize unlinks whose cooling-off elapsed (WS-L.2.5b). */
export async function finalizeElapsedUnlinks(
  deps: Pick<WalletServiceDeps, 'wallets' | 'audit' | 'now' | 'log'>,
): Promise<number> {
  const nowIso = new Date(deps.now()).toISOString();
  const pending = await deps.wallets.listPendingFinalization(nowIso);
  for (const wallet of pending) {
    await deps.wallets.update({
      ...wallet,
      unlinkState: 'finalized',
      unlinkedAt: nowIso,
    });
    await deps.audit.append({
      actorUserId: null,
      eventType: 'wallet_unlink',
      targetRef: wallet.addressTruncated,
      context: { setting: 'finalize' },
    });
  }
  if (pending.length > 0) deps.log('knomosis.wallet.unlinks_finalized', { count: pending.length });
  return pending.length;
}

const RISK_EXPLANATIONS: Record<WalletRiskState, { explanation: string; nextStep: string | null }> =
  {
    pending: {
      explanation:
        'This wallet has not completed its first risk assessment yet. High-value actions stay unavailable until the assessment completes.',
      nextStep: 'No action needed — the assessment runs automatically.',
    },
    normal: {
      explanation: 'No elevated risk signals are associated with this wallet.',
      nextStep: null,
    },
    elevated: {
      explanation:
        'Some activity patterns associated with this wallet require additional review. Certain actions may need extra verification.',
      nextStep: 'Additional verification may be required before high-value transfers.',
    },
    high: {
      explanation: 'This wallet is currently restricted from financial actions pending review.',
      nextStep: 'Contact support to resolve the restriction.',
    },
  };

/** WS-L.2.5c-1 — owner-readable risk state (label + safe explanation only). */
export async function walletRiskState(
  deps: WalletServiceDeps,
  args: { userId: string; walletAccountId: string },
): Promise<
  | { ok: true; riskState: WalletRiskState; explanation: string; nextStep: string | null }
  | WalletServiceError
> {
  const wallet = await deps.wallets.getById(args.walletAccountId);
  if (wallet === null || wallet.userId !== args.userId) {
    return err(404, 'not_found', 'Resource not found');
  }

  let state: WalletRiskState = wallet.riskState;
  // Read-through to the WS-N seam: a completed assessment updates the stored
  // state; an unavailable engine leaves `pending` in place (fail closed).
  const assessment = await deps.compliance.walletRisk({
    walletAccountId: wallet.walletAccountId,
    userId: args.userId,
  });
  if (assessment !== 'unavailable' && assessment.state !== state) {
    state = assessment.state;
    await deps.wallets.update({ ...wallet, riskState: state });
  }
  const text =
    assessment !== 'unavailable'
      ? { explanation: assessment.explanation, nextStep: assessment.nextStep }
      : RISK_EXPLANATIONS[state];
  return { ok: true, riskState: state, explanation: text.explanation, nextStep: text.nextStep };
}
