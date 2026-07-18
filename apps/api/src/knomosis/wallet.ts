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
  WalletAbuseLimiterPort,
} from './stores.js';
import { resolveWalletRiskState } from './wallet-risk-resolve.js';

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
  abuse: WalletAbuseLimiterPort;
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
  /** WS-N.2.2a/e — the sanctioned-wallet-link response: the boot wires the
   *  compliance pin+case hook here (the ONLY moment the plaintext address
   *  exists server-side, so link-time screening must act HERE).  Absent ⇒
   *  the wallet simply stays `pending` (fail-closed: it cannot move funds). */
  onSanctionedWalletLink?: ((walletAccountId: string, userId: string) => Promise<void>) | undefined;
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
  if (!(await deps.abuse.hit(`nonce:${args.userId}`, config.linkAttemptsPerHour, 3_600_000))) {
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
/**
 * WS-N.2.2a — the FIRST assessment's screening leg, at the only moment the
 * plaintext address exists server-side (WS-D stores financial addresses as
 * keyed hashes).  A `blocked` verdict fires the compliance hook (pin `high` +
 * a critical sanctions case); an outage or error leaves the fail-closed
 * `pending` state.  Never throws.
 *
 * A `clear` verdict is the ONLY thing that may take a wallet out of `pending`,
 * and it must do so HERE.  This is the one moment the plaintext address exists
 * (it is stored hashed), so it is the one moment the wallet can be screened at
 * all — `walletRisk` later reads pins and cases and says `normal` when it finds
 * none, which is just as true of a wallet that was never screened.  We RECORD
 * the clearance by promoting the stored `pending`→`normal` (a CAS, so a racing
 * escalation is never clobbered); the shared read-through (`resolveWalletRiskState`)
 * then refuses to promote the rest — an absence-of-signal `normal` from
 * `walletRisk` cannot lift a `pending` wallet.  An outage therefore leaves the
 * wallet pending until it is re-linked — the honest outcome: we could not
 * certify it, and nothing later can.
 */
async function screenLinkedWallet(
  deps: WalletServiceDeps,
  addressLower: string,
  walletAccountId: string,
  userId: string,
): Promise<WalletRiskState | null> {
  try {
    const verdict = await deps.compliance.screenAddress({
      addressLower,
      deploymentId: 'wallet-link',
    });
    if (verdict === 'clear') {
      // The ONE positive clearance: this is the only moment the plaintext address
      // exists, so it is the only moment the wallet can be screened at all.
      // Record it by lifting the fail-closed `pending` state to `normal` — a CAS
      // from `pending`, so a racing escalation is never clobbered.  Absence of
      // adverse signals can NOT do this later (`resolveWalletRiskState`): it is
      // equally true of a wallet that was never screened.  Return the recorded
      // state so the caller's returned record reflects it (no stale re-read).
      await deps.wallets.updateRiskState(walletAccountId, 'normal', 'pending');
      return 'normal';
    }
    if (verdict !== 'blocked') return null; // `unavailable`: stay `pending` until re-linked
    // ALERT FIRST, then record.  A hook that throws (the chain is down) used to
    // take the alert with it, so a sanctions match at link could leave no pin,
    // no case, and no signal — the one outcome an operator must hear about.
    deps.alert('knomosis.wallet.link_sanctioned', { wallet_account_id: walletAccountId });
    if (deps.onSanctionedWalletLink !== undefined) {
      await deps.onSanctionedWalletLink(walletAccountId, userId);
    }
    // `blocked`: the pin/case is the record; the wallet stays `pending` (a later
    // read-through derives `high` from the pin) — no promotion here.
    return null;
  } catch (error) {
    // Fail-closed by inaction: the wallet stays `pending`, which cannot move
    // funds until an assessment resolves it — and every fund transfer
    // re-screens this address anyway.
    deps.alert('knomosis.wallet.link_screen_failed', {
      wallet_account_id: walletAccountId,
      message: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

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
  if (!(await deps.abuse.hit(`link:${args.userId}`, config.linkAttemptsPerHour, 3_600_000))) {
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
  // CROSS-USER ownership (chain-AGNOSTIC): an address belongs to ONE account across
  // every chain WHILE it has a LIVE (non-finalized) row, so a DIFFERENT account can
  // never link it — enforced here so that a per-chain row (below) never lets a second
  // user claim an address on another chain.  A FINALIZED unlink RELEASES the address,
  // so a finalized tombstone (this or another account's) does NOT block a new
  // key-proving owner (no enumeration oracle: the caller learns only that the link
  // failed, WS-L.2.5a).
  const ownedElsewhere = await deps.wallets.getActiveOwnerByAddressHash(addressHashHex);
  if (ownedElsewhere !== null && ownedElsewhere.userId !== args.userId) {
    return err(409, 'address_unavailable', 'This wallet cannot be linked to this account.');
  }
  // The caller's OWN per-chain row (this address on the SIWE `chainId`) drives
  // relink/idempotency; the SAME address on a DIFFERENT active chain is a distinct,
  // freshly-linkable row.  Scoped to args.userId so a DIFFERENT account's released
  // (finalized) tombstone for the same (address, chain) is never mistaken for the
  // caller's row (WS-L.2.5a).
  const existing = await deps.wallets.getByAddressHashAndChain(
    addressHashHex,
    verified.chainId,
    args.userId,
  );
  const nowIso = new Date(nowMs).toISOString();

  if (existing !== null) {
    // `existing` is owned by args.userId (the cross-user check above already ran).
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
      // Reactivating a finalized wallet counts toward the cap exactly like a
      // fresh link.  The count + state change run ATOMICALLY under the SAME
      // address + per-user locks as the new-link path, so two concurrent relinks
      // can't exceed maxWalletsPerUser and a concurrent cross-chain link of the same
      // address by ANOTHER account can't leave two live rows (WS-L.2.5a).
      const reactivated = await deps.wallets.reactivateIfUnderCap(
        {
          ...existing,
          unlinkState: 'active',
          riskState: 'pending', // fail-closed: reassess on re-link
          linkedAt: nowIso,
          unlinkRequestedAt: null,
          unlinkFinalizeAfter: null,
          unlinkedAt: null,
          ...(args.label !== undefined ? { label: args.label } : {}),
        },
        config.maxWalletsPerUser,
      );
      if (reactivated === 'address_taken') {
        // Another account claimed a live row for this address between the outer
        // check and the reactivation — the store's address lock caught it.  No
        // enumeration oracle: the caller learns only that the link failed.
        return err(409, 'address_unavailable', 'This wallet cannot be linked to this account.');
      }
      if (reactivated === 'cap_exceeded') {
        return err(
          429,
          'wallet_limit',
          `You can link at most ${config.maxWalletsPerUser} wallets.`,
        );
      }
      await deps.audit.append({
        actorUserId: args.userId,
        eventType: 'wallet_link',
        targetRef: reactivated.addressTruncated,
        context: { setting: 'relink' },
      });
      const reactivatedRisk = await screenLinkedWallet(
        deps,
        verified.addressLower,
        reactivated.walletAccountId,
        args.userId,
      );
      return {
        ok: true,
        wallet:
          reactivatedRisk !== null ? { ...reactivated, riskState: reactivatedRisk } : reactivated,
        alreadyLinked: false,
      };
    }
    // active or pending_unlink: idempotent re-link; a pending unlink is
    // CANCELLED by re-linking during the cooling-off window (WS-L.2.5b).  The
    // cancel is COLUMN-SCOPED — a full-record `update({...existing})` would write
    // the stale `existing` snapshot back over any `riskState` a compliance
    // escalation persisted between the read above and this write, silently
    // restoring a prior `normal` and losing the fail-closed fund restriction.  The
    // method returns the FRESH row, so the `pending` re-screen below (and the
    // response) reflect a concurrent escalation rather than the stale read.
    const record =
      existing.unlinkState === 'pending_unlink'
        ? ((await deps.wallets.cancelPendingUnlink(existing.walletAccountId)) ?? existing)
        : existing;
    // A wallet still `pending` from a link-time screening OUTAGE has NO other
    // recovery route: the read-through now refuses to promote it from an
    // absence-of-signal `normal` (thread-Y), so without re-screening here it is
    // fund-blocked until an unlink→finalize→cooldown→relink.  Re-screen on the
    // re-link so a recovered provider can clear it.  Idempotent: a `clear` CASes
    // `pending`→`normal`, `unavailable` leaves it pending, and the blocked hook
    // dedups per ACTIVE PIN (idempotent pin + `sanctions:link:<pin.id>` case), so a
    // re-freeze after the prior incident resolved opens a fresh reviewable case.
    if (record.riskState === 'pending') {
      const rescreened = await screenLinkedWallet(
        deps,
        verified.addressLower,
        record.walletAccountId,
        args.userId,
      );
      if (rescreened !== null) {
        return { ok: true, wallet: { ...record, riskState: rescreened }, alreadyLinked: true };
      }
    }
    return { ok: true, wallet: record, alreadyLinked: true };
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
  // ATOMIC cap check + insert (per-user lock): a bare count-then-insert races two
  // concurrent links past `maxWalletsPerUser` (WS-L.2.5a).
  const inserted = await deps.wallets.insertIfUnderCap(record, config.maxWalletsPerUser);
  if (inserted === 'address_taken') {
    // The address was claimed by ANOTHER account between the pre-check and the
    // insert (a concurrent cross-chain link) — the store's address lock caught it.
    // No enumeration oracle: the caller learns only that the link failed (WS-L.2.5a).
    return err(409, 'address_unavailable', 'This wallet cannot be linked to this account.');
  }
  if (inserted === 'cap_exceeded') {
    return err(429, 'wallet_limit', `You can link at most ${config.maxWalletsPerUser} wallets.`);
  }
  if (!inserted.created) {
    // A concurrent same-user link already created this exact `(address, chain)` row
    // under the store's address lock — an idempotent relink, NOT a fresh link: return
    // the existing wallet as `alreadyLinked` without a duplicate audit/log entry.
    return { ok: true, wallet: inserted.wallet, alreadyLinked: true };
  }
  await deps.audit.append({
    actorUserId: args.userId,
    eventType: 'wallet_link',
    // The truncation only — never the full address (§19.5).
    targetRef: inserted.wallet.addressTruncated,
    context: { setting: 'link' },
  });
  deps.log('knomosis.wallet.linked', {
    chain_id: inserted.wallet.chainId,
    type: inserted.wallet.walletType,
  });
  const insertedRisk = await screenLinkedWallet(
    deps,
    verified.addressLower,
    inserted.wallet.walletAccountId,
    args.userId,
  );
  return {
    ok: true,
    wallet:
      insertedRisk !== null ? { ...inserted.wallet, riskState: insertedRisk } : inserted.wallet,
    alreadyLinked: false,
  };
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
  // Column-scoped: writing back the full `wallet` snapshot could restore
  // `unlinkState: 'active'` and clear the cooling-off fields of an unlink that
  // committed concurrently, silently cancelling it — a label edit must touch ONLY
  // the label column (WS-L.2.5c).
  await deps.wallets.updateLabel(args.walletAccountId, args.label);
  await deps.audit.append({
    actorUserId: args.userId,
    eventType: 'wallet_label_change',
    targetRef: wallet.addressTruncated,
    context: { setting: 'label' },
  });
  return { ok: true, wallet: { ...wallet, label: args.label } };
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

/** WS-L.2.5b — collect every OPEN unlink obligation for a wallet (fail closed). */
async function collectUnlinkObligations(
  deps: Pick<WalletServiceDeps, 'actions' | 'proposalSignatures' | 'treasuryObligations'>,
  walletAccountId: string,
): Promise<UnlinkObligation[]> {
  const obligations: UnlinkObligation[] = [];
  for (const action of await deps.actions.listOpenByWallet(walletAccountId)) {
    obligations.push(actionObligation(action.actionType, action.actionRecordId));
  }
  for (const signature of await deps.proposalSignatures.listOpenByWallet(walletAccountId)) {
    obligations.push({
      type: 'active_proposal',
      ref: signature.proposalId,
      description: 'This wallet signed a governance proposal whose vote is still open.',
    });
  }
  for (const external of await deps.treasuryObligations.obligationsForWallet(walletAccountId)) {
    obligations.push({
      type: external.type === 'pending_grant' ? 'pending_grant' : 'pending_payment',
      ref: external.ref,
      description: external.description,
    });
  }
  return obligations;
}

/** WS-L.2.5b — obligation-checked unlink request with cooling-off. */
export async function requestUnlink(
  deps: WalletServiceDeps,
  args: { userId: string; walletAccountId: string },
): Promise<UnlinkRequestOutcome> {
  const config = deps.config();
  if (!(await deps.abuse.hit(`unlink:${args.userId}`, config.unlinkRequestsPerDay, 86_400_000))) {
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

  // WS-L.2.5b obligation check: fail closed on any open item.
  const obligations = await collectUnlinkObligations(deps, wallet.walletAccountId);
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
  deps: Pick<
    WalletServiceDeps,
    'wallets' | 'audit' | 'now' | 'log' | 'actions' | 'proposalSignatures' | 'treasuryObligations'
  >,
): Promise<number> {
  const nowIso = new Date(deps.now()).toISOString();
  const pending = await deps.wallets.listPendingFinalization(nowIso);
  let finalized = 0;
  for (const wallet of pending) {
    // RE-CHECK obligations at finalization: a wallet may have gained a blocking
    // obligation DURING the cooling-off window (e.g. an action record that only
    // materialized after the unlink request), so it must not be finalized while
    // an obligation is open — it stays `pending_unlink` for the next sweep.
    if ((await collectUnlinkObligations(deps, wallet.walletAccountId)).length > 0) {
      deps.log('knomosis.wallet.finalize_deferred_obligation', {
        wallet: wallet.addressTruncated,
      });
      continue;
    }
    // CONDITIONAL finalize: if a re-link cancelled the unlink between the list and
    // now, the CAS matches nothing and we skip — never clobbering the reactivated
    // wallet back to `finalized` (WS-L.2.5b).
    const applied = await deps.wallets.finalizeIfStillPending(
      wallet.walletAccountId,
      wallet.unlinkFinalizeAfter,
      nowIso,
    );
    if (!applied) {
      deps.log('knomosis.wallet.finalize_skipped_relinked', { wallet: wallet.addressTruncated });
      continue;
    }
    await deps.audit.append({
      actorUserId: null,
      eventType: 'wallet_unlink',
      targetRef: wallet.addressTruncated,
      context: { setting: 'finalize' },
    });
    finalized += 1;
  }
  if (finalized > 0) deps.log('knomosis.wallet.unlinks_finalized', { count: finalized });
  return finalized;
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

  // Read-through the shared WS-N seam (thread-Y fail-closed): a completed
  // assessment updates the stored state and escalations apply, but an absence-of-
  // signal `normal` never lifts a still-unscreened `pending` wallet, and an
  // unavailable engine leaves the stored state in place.
  const { state, assessment } = await resolveWalletRiskState(deps, {
    walletAccountId: wallet.walletAccountId,
    userId: args.userId,
    riskState: wallet.riskState,
  });
  // Key the explanation off the RESOLVED state: when a `normal` assessment was
  // refused (kept `pending`), show the pending copy, not "no elevated risk".
  const text =
    assessment !== 'unavailable' && assessment.state === state
      ? { explanation: assessment.explanation, nextStep: assessment.nextStep }
      : RISK_EXPLANATIONS[state];
  return { ok: true, riskState: state, explanation: text.explanation, nextStep: text.nextStep };
}
