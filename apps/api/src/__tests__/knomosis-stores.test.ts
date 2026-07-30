// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L in-memory store adapters — exhaustive method coverage (the same
// interfaces the gated Drizzle adapters implement).  Each store's list/query/
// update/idempotency paths are exercised directly so the durability contract
// is verified independent of the higher-level flows.

import { describe, expect, it } from 'vitest';
import {
  type FinancialWalletRecord,
  type GovernanceProposalRecord,
  InMemoryComprehensionStore,
  InMemoryFinancialWalletStore,
  InMemoryGovernanceProposalStore,
  InMemoryGovernanceSignatureStore,
  InMemoryKnomosisActionStore,
  InMemoryKnomosisDeploymentStore,
  InMemoryKnomosisReceiptStore,
  InMemoryProposalVoteStore,
  InMemoryReconciliationStore,
  InMemorySimTreasuryStore,
  InMemoryWalletActorMappingStore,
  type KnomosisActionRecordEntity,
  selectGatewayBoundAction,
} from '../knomosis/stores.js';

const now = () => new Date().toISOString();

function wallet(over: Partial<FinancialWalletRecord> = {}): FinancialWalletRecord {
  return {
    walletAccountId: crypto.randomUUID(),
    userId: 'u1',
    addressHashHex: crypto.randomUUID(),
    addressTruncated: '0x00…00',
    chainId: 1,
    walletType: 'eoa',
    unlinkState: 'active',
    riskState: 'pending',
    label: null,
    linkedAt: now(),
    lastUsedAt: null,
    unlinkRequestedAt: null,
    unlinkFinalizeAfter: null,
    unlinkedAt: null,
    ...over,
  };
}

function action(over: Partial<KnomosisActionRecordEntity> = {}): KnomosisActionRecordEntity {
  return {
    actionRecordId: crypto.randomUUID(),
    deploymentId: 'd1',
    actionType: 'treasury_deposit',
    roomId: 'r1',
    actorWalletAccountId: 'w1',
    actorUserId: 'u1',
    payloadHash: `0x${'11'.repeat(32)}`,
    typedDataHash: `0x${'22'.repeat(32)}`,
    signedAction: { message: {}, signature: '0x' },
    submissionState: 'submitted',
    failureReason: null,
    indexedEventRef: null,
    reconciliationState: 'pending',
    idempotencyKey: crypto.randomUUID(),
    paymentIntentId: null,
    createdAt: now(),
    updatedAt: now(),
    ...over,
  };
}

function proposal(over: Partial<GovernanceProposalRecord> = {}): GovernanceProposalRecord {
  return {
    proposalId: crypto.randomUUID(),
    roomId: 'r1',
    proposerUserId: 'u1',
    proposalType: 'bounty',
    title: 't',
    plainLanguageSummary: 's',
    requestedAmount: '10',
    asset: 'SIM-USDC',
    recipientRef: 'x',
    conflictDisclosures: 'none',
    riskAssessment: 'low',
    requestedAction: {},
    expectedDeliverable: 'd',
    preflightState: 'passed',
    votingState: 'open',
    challengeState: 'none',
    executionState: 'not_executed',
    simulationMode: true,
    executableAfter: null,
    createdAt: now(),
    executedAt: null,
    executionClaimedAt: null,
    ...over,
  };
}

describe('InMemoryFinancialWalletStore', () => {
  it('rejects a duplicate address hash and lists by user with the unlinked filter', async () => {
    const store = new InMemoryFinancialWalletStore();
    const w = wallet({ addressHashHex: 'dup' });
    await store.insert(w);
    await expect(store.insert(wallet({ addressHashHex: 'dup' }))).rejects.toThrow();
    await store.insert(wallet({ userId: 'u1', unlinkState: 'finalized' }));
    expect(await store.listByUser('u1', false)).toHaveLength(1);
    expect(await store.listByUser('u1', true)).toHaveLength(2);
    expect(await store.getByAddressHash('dup')).not.toBeNull();
    expect(await store.getByAddressHash('missing')).toBeNull();
    await expect(store.update(wallet({ walletAccountId: 'nope' }))).rejects.toThrow();
  });

  it('lists wallets whose cooling-off elapsed', async () => {
    const store = new InMemoryFinancialWalletStore();
    const past = new Date(Date.now() - 1000).toISOString();
    await store.insert(wallet({ unlinkState: 'pending_unlink', unlinkFinalizeAfter: past }));
    await store.insert(wallet({ unlinkState: 'pending_unlink', unlinkFinalizeAfter: null }));
    expect(await store.listPendingFinalization(now())).toHaveLength(1);
  });

  it('uniqueness is PER (address, chain): same address on two chains, not one chain twice (G1)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const addr = 'addr-x';
    await store.insert(wallet({ addressHashHex: addr, chainId: 1 }));
    // The SAME address on a DIFFERENT chain is allowed — a distinct per-chain row.
    await store.insert(wallet({ addressHashHex: addr, chainId: 11155111 }));
    // The same (address, chain) is rejected (mirrors the DB unique index).
    await expect(store.insert(wallet({ addressHashHex: addr, chainId: 1 }))).rejects.toThrow();
    // Per-chain lookup (scoped to the owner) resolves the right row; a chain with no
    // row for this user is null; chain-agnostic getByAddressHash returns any.
    expect((await store.getByAddressHashAndChain(addr, 11155111, 'u1'))?.chainId).toBe(11155111);
    expect(await store.getByAddressHashAndChain(addr, 999, 'u1')).toBeNull();
    // A DIFFERENT account has no row for (addr, chain), even one this address exists on.
    expect(await store.getByAddressHashAndChain(addr, 11155111, 'u2')).toBeNull();
    expect(await store.getByAddressHash(addr)).not.toBeNull();
  });

  it('insertIfUnderCap rejects an address ANOTHER account owns (H1)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const addr = 'shared-addr';
    // u1 owns the address on chain 1.
    expect(
      typeof (await store.insertIfUnderCap(wallet({ userId: 'u1', addressHashHex: addr }), 5)),
    ).toBe('object');
    // u2 cannot link the same address — on ANY chain — an address is owned by ONE
    // account across every chain (cross-user ownership check).
    expect(
      await store.insertIfUnderCap(wallet({ userId: 'u2', addressHashHex: addr, chainId: 1 }), 5),
    ).toBe('address_taken');
    expect(
      await store.insertIfUnderCap(
        wallet({ userId: 'u2', addressHashHex: addr, chainId: 11155111 }),
        5,
      ),
    ).toBe('address_taken');
    // The owning account is still under the cap → a DIFFERENT address links fine.
    const created = await store.insertIfUnderCap(
      wallet({ userId: 'u1', addressHashHex: 'other' }),
      5,
    );
    expect(created).not.toBe('address_taken');
    expect(created).not.toBe('cap_exceeded');
    if (typeof created !== 'string') expect(created.created).toBe(true);
  });

  it('insertIfUnderCap is idempotent for a concurrent same-user (address,chain) relink (J1)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const addr = 'race-addr';
    const first = await store.insertIfUnderCap(
      wallet({ userId: 'u1', addressHashHex: addr, chainId: 1 }),
      5,
    );
    expect(typeof first).not.toBe('string');
    if (typeof first === 'string') throw new Error('unreachable');
    expect(first.created).toBe(true);
    // A concurrent same-user link for the SAME (address, chain) — the caller's outer
    // pre-check saw no row — returns the EXISTING wallet as an idempotent relink, NOT
    // a thrown unique-constraint or a spurious cap_exceeded.
    const again = await store.insertIfUnderCap(
      wallet({ userId: 'u1', addressHashHex: addr, chainId: 1 }),
      5,
    );
    expect(typeof again).not.toBe('string');
    if (typeof again === 'string') throw new Error('unreachable');
    expect(again.created).toBe(false);
    expect(again.wallet.walletAccountId).toBe(first.wallet.walletAccountId);
    // The relink did NOT create a second row.
    expect(await store.listByUser('u1', true)).toHaveLength(1);
    // Even AT the cap, an idempotent relink still succeeds (it adds no new row).
    const atCap = await store.insertIfUnderCap(
      wallet({ userId: 'u1', addressHashHex: addr, chainId: 1 }),
      1,
    );
    expect(atCap).not.toBe('cap_exceeded');
    if (typeof atCap !== 'string') expect(atCap.created).toBe(false);
  });

  it('a FINALIZED unlink releases the (address,chain) for a new owner (K3)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const addr = 'released-addr';
    // Account A links the address (active).
    const a = await store.insertIfUnderCap(
      wallet({ userId: 'A', addressHashHex: addr, chainId: 1 }),
      5,
    );
    if (typeof a === 'string') throw new Error('unreachable');
    // While A's row is LIVE, account B cannot link the same address (cross-user).
    expect(
      await store.insertIfUnderCap(wallet({ userId: 'B', addressHashHex: addr, chainId: 1 }), 5),
    ).toBe('address_taken');
    // A finalizes the unlink (the tombstone is RETAINED for audit + A's cooldown).
    await store.update({ ...a.wallet, unlinkState: 'finalized', unlinkedAt: now() });
    // Now the address is RELEASED: it has no live owner, so the cross-user check
    // ignores A's finalized tombstone…
    expect(await store.getActiveOwnerByAddressHash(addr)).toBeNull();
    // …and account B (who proves key control via SIWE upstream) can link it.
    const b = await store.insertIfUnderCap(
      wallet({ userId: 'B', addressHashHex: addr, chainId: 1 }),
      5,
    );
    if (typeof b === 'string') throw new Error(`expected a wallet, got ${b}`);
    expect(b.created).toBe(true);
    // Both rows coexist: A's finalized tombstone + B's active row.
    expect(await store.getActiveOwnerByAddressHash(addr)).not.toBeNull();
    expect((await store.getActiveOwnerByAddressHash(addr))?.userId).toBe('B');
    expect(await store.listByUser('A', true)).toHaveLength(1); // A's tombstone retained
    // The per-chain lookup is per-owner: B sees its row, A sees only its finalized one.
    expect((await store.getByAddressHashAndChain(addr, 1, 'B'))?.userId).toBe('B');
    expect((await store.getByAddressHashAndChain(addr, 1, 'A'))?.unlinkState).toBe('finalized');
    // With B now the LIVE owner, a THIRD account is blocked again.
    expect(
      await store.insertIfUnderCap(wallet({ userId: 'C', addressHashHex: addr, chainId: 1 }), 5),
    ).toBe('address_taken');
  });

  it('reactivation is blocked once another account owns a live row for the address (L2)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const addr = 'reactivate-addr';
    // Account A links (chain 1), then finalizes the unlink.
    const a = await store.insertIfUnderCap(
      wallet({ userId: 'A', addressHashHex: addr, chainId: 1 }),
      5,
    );
    if (typeof a === 'string') throw new Error('unreachable');
    await store.update({ ...a.wallet, unlinkState: 'finalized', unlinkedAt: now() });
    // Account B links the SAME address on a DIFFERENT chain (allowed — A released it),
    // becoming the live owner across the address.
    const b = await store.insertIfUnderCap(
      wallet({ userId: 'B', addressHashHex: addr, chainId: 11155111 }),
      5,
    );
    if (typeof b === 'string') throw new Error(`expected a wallet, got ${b}`);
    // A tries to RE-LINK (reactivate) its finalized chain-1 row → BLOCKED under the
    // address lock: B now owns a live row, so two accounts must not both hold live
    // rows for the same address (the partial index is only per (address, chain)).
    expect(await store.reactivateIfUnderCap({ ...a.wallet, unlinkState: 'active' }, 5)).toBe(
      'address_taken',
    );
    // Once B finalizes too, the address is free again and A can reactivate.
    await store.update({ ...b.wallet, unlinkState: 'finalized', unlinkedAt: now() });
    const reactivated = await store.reactivateIfUnderCap({ ...a.wallet, unlinkState: 'active' }, 5);
    expect(typeof reactivated).not.toBe('string');
    if (typeof reactivated !== 'string') expect(reactivated.unlinkState).toBe('active');
  });

  it('updateRiskState changes ONLY riskState — never the lifecycle fields (H3)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const finalizeAfter = new Date(Date.now() + 60_000).toISOString();
    const w = wallet({
      riskState: 'pending',
      unlinkState: 'pending_unlink',
      unlinkFinalizeAfter: finalizeAfter,
      label: 'my-wallet',
    });
    await store.insert(w);
    // A risk read-through writes ONLY the risk column; a concurrent unlink's fields
    // (unlinkState / unlinkFinalizeAfter / label) survive untouched.
    await store.updateRiskState(w.walletAccountId, 'elevated');
    const after = await store.getById(w.walletAccountId);
    expect(after?.riskState).toBe('elevated');
    expect(after?.unlinkState).toBe('pending_unlink');
    expect(after?.unlinkFinalizeAfter).toBe(finalizeAfter);
    expect(after?.label).toBe('my-wallet');
    // A missing wallet is a silent no-op (never throws).
    await expect(store.updateRiskState('nope', 'high')).resolves.toBeUndefined();
  });

  it('updateLabel changes ONLY the label — never the lifecycle fields (M1)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const finalizeAfter = new Date(Date.now() + 60_000).toISOString();
    const w = wallet({
      unlinkState: 'pending_unlink',
      unlinkFinalizeAfter: finalizeAfter,
      riskState: 'elevated',
      label: 'old',
    });
    await store.insert(w);
    // A label edit writes ONLY the label; a concurrent unlink's fields survive, so it
    // cannot restore unlinkState:'active' and cancel the audited unlink.
    await store.updateLabel(w.walletAccountId, 'renamed');
    const after = await store.getById(w.walletAccountId);
    expect(after?.label).toBe('renamed');
    expect(after?.unlinkState).toBe('pending_unlink');
    expect(after?.unlinkFinalizeAfter).toBe(finalizeAfter);
    expect(after?.riskState).toBe('elevated');
    await expect(store.updateLabel('nope', 'x')).resolves.toBeUndefined();
  });

  it('cancelPendingUnlink is column-scoped — a risk escalation landing first is NOT clobbered (codex: preserve risk on relink)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const finalizeAfter = new Date(Date.now() + 60_000).toISOString();
    const w = wallet({
      unlinkState: 'pending_unlink',
      unlinkRequestedAt: new Date().toISOString(),
      unlinkFinalizeAfter: finalizeAfter,
      riskState: 'normal',
      label: 'my-wallet',
    });
    await store.insert(w);
    // A caller reads the row (riskState 'normal') — the stale snapshot a full-record
    // relink-cancel would write back.  A compliance escalation then persists `high`.
    const stale = await store.getById(w.walletAccountId);
    expect(stale?.riskState).toBe('normal');
    await store.updateRiskState(w.walletAccountId, 'high');
    // Cancelling the unlink flips ONLY the lifecycle fields; the `high` survives and
    // the label is untouched (a full `update({...stale})` would restore `normal`).
    const cancelled = await store.cancelPendingUnlink(w.walletAccountId);
    expect(cancelled?.unlinkState).toBe('active');
    expect(cancelled?.riskState).toBe('high');
    expect(cancelled?.label).toBe('my-wallet');
    const after = await store.getById(w.walletAccountId);
    expect(after?.unlinkState).toBe('active');
    expect(after?.unlinkRequestedAt).toBeNull();
    expect(after?.unlinkFinalizeAfter).toBeNull();
    expect(after?.riskState).toBe('high');
    // Idempotent on an already-active row, and null for a missing one.
    expect((await store.cancelPendingUnlink(w.walletAccountId))?.unlinkState).toBe('active');
    expect(await store.cancelPendingUnlink('nope')).toBeNull();
  });

  it('comprehension record keeps a pass monotonic — a later fail never downgrades it (M2)', async () => {
    const store = new InMemoryComprehensionStore();
    const now = () => new Date().toISOString();
    const passed = await store.record('u1', 'v1', true, now());
    expect(passed.passed).toBe(true);
    // A later FAILING attempt must NOT revert the pass (the race the SQL merge guards).
    const thenFailed = await store.record('u1', 'v1', false, now());
    expect(thenFailed.passed).toBe(true);
    expect(thenFailed.attempts).toBe(2);
    expect(thenFailed.passedAt).not.toBeNull();
    expect((await store.get('u1', 'v1'))?.passed).toBe(true);
  });
});

describe('InMemoryKnomosisActionStore', () => {
  it('enforces idempotency, finds by typed-data hash, lists open-by-wallet', async () => {
    const store = new InMemoryKnomosisActionStore();
    const a = action({ actorUserId: 'u1', idempotencyKey: 'idem', typedDataHash: '0xhash' });
    await store.insert(a);
    await expect(
      store.insert(action({ actorUserId: 'u1', idempotencyKey: 'idem' })),
    ).rejects.toThrow();
    expect(await store.getByIdempotencyKey('u1', 'idem')).not.toBeNull();
    expect(await store.getByIdempotencyKey('u1', 'other')).toBeNull();
    expect(await store.getByTypedDataHash('d1', '0xhash')).not.toBeNull();
    expect(await store.getByTypedDataHash('d1', '0xnope')).toBeNull();
    // Open-by-wallet excludes terminal states.
    await store.insert(action({ actorWalletAccountId: 'w1', submissionState: 'accepted' }));
    await store.insert(action({ actorWalletAccountId: 'w1', submissionState: 'finalized' }));
    const open = await store.listOpenByWallet('w1');
    expect(open.every((r) => r.submissionState !== 'finalized')).toBe(true);
    expect((await store.listByRoom('r1', 10)).length).toBeGreaterThan(0);
    expect((await store.listUnreconciled('d1', 10)).length).toBeGreaterThan(0);
    await expect(store.update(action({ actionRecordId: 'nope' }))).rejects.toThrow();
  });

  it('deploymentIdsWithInFlightActions lists deployments with settling actions only (H5)', async () => {
    const store = new InMemoryKnomosisActionStore();
    // dA: an in-flight (submitted) action → keep maintaining even if the deployment
    // later goes inactive, so its gateway events settle and unblock wallet unlink.
    await store.insert(action({ deploymentId: 'dA', submissionState: 'submitted' }));
    // dB: only terminal actions → nothing to settle.
    await store.insert(action({ deploymentId: 'dB', submissionState: 'finalized' }));
    await store.insert(action({ deploymentId: 'dB', submissionState: 'reverted' }));
    // dC: only a `reserving` row (pre-submit, nothing on-chain) → excluded; the
    // stale-reservation sweep handles it, not ingest/reconcile.
    await store.insert(action({ deploymentId: 'dC', submissionState: 'reserving' }));
    const ids = new Set(await store.deploymentIdsWithInFlightActions());
    expect(ids.has('dA')).toBe(true);
    expect(ids.has('dB')).toBe(false);
    expect(ids.has('dC')).toBe(false);
  });

  it('getByTypedDataHash resolves duplicates to the gateway-bound row, not the failed loser (F4)', async () => {
    const store = new InMemoryKnomosisActionStore();
    const hash = `0x${'ab'.repeat(32)}`;
    // Duplicate preflight+submit: the loser FAILED (NONCE_REUSED), the winner
    // forwarded (`submitted`).  They share (deployment, typedDataHash).
    const loser = action({
      deploymentId: 'd1',
      typedDataHash: hash,
      submissionState: 'failed',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const winner = action({
      deploymentId: 'd1',
      typedDataHash: hash,
      submissionState: 'submitted',
      createdAt: '2026-07-01T00:00:01.000Z',
    });
    // Insert loser FIRST so a naive "first match" would return it.
    await store.insert(loser);
    await store.insert(winner);
    expect((await store.getByTypedDataHash('d1', hash))?.actionRecordId).toBe(
      winner.actionRecordId,
    );
    // Deterministic regardless of input order.
    expect(selectGatewayBoundAction([loser, winner])?.actionRecordId).toBe(winner.actionRecordId);
    expect(selectGatewayBoundAction([winner, loser])?.actionRecordId).toBe(winner.actionRecordId);
    // A `reserving` sibling ranks below `failed`, never chosen over a forwarded row.
    const reserving = action({
      deploymentId: 'd1',
      typedDataHash: hash,
      submissionState: 'reserving',
    });
    expect(selectGatewayBoundAction([reserving, winner])?.actionRecordId).toBe(
      winner.actionRecordId,
    );
    expect(selectGatewayBoundAction([])).toBeNull();
  });

  it('listAllReservingOlderThan spans deployments and excludes fresh rows (F5)', async () => {
    const store = new InMemoryKnomosisActionStore();
    const old = '2026-07-01T00:00:00.000Z';
    const fresh = '2026-07-01T12:00:00.000Z';
    await store.insert(
      action({ deploymentId: 'dA', submissionState: 'reserving', createdAt: old }),
    );
    await store.insert(
      action({ deploymentId: 'dB', submissionState: 'reserving', createdAt: old }),
    );
    await store.insert(
      action({ deploymentId: 'dA', submissionState: 'reserving', createdAt: fresh }),
    );
    await store.insert(
      action({ deploymentId: 'dA', submissionState: 'submitted', createdAt: old }),
    );
    const cutoff = '2026-07-01T06:00:00.000Z';
    const stale = await store.listAllReservingOlderThan(cutoff, 50);
    // Both OLD reserving rows across dA + dB; NOT the fresh one, NOT the submitted one.
    expect(stale).toHaveLength(2);
    expect(new Set(stale.map((r) => r.deploymentId))).toEqual(new Set(['dA', 'dB']));
    expect(stale.every((r) => r.submissionState === 'reserving' && r.createdAt < cutoff)).toBe(
      true,
    );
  });
});

describe('InMemoryGovernanceProposalStore + votes + signatures', () => {
  it('lists executable + open-by-type and updates', async () => {
    const store = new InMemoryGovernanceProposalStore();
    const past = new Date(Date.now() - 1000).toISOString();
    await store.insert(
      proposal({ executionState: 'timelocked', executableAfter: past, votingState: 'passed' }),
    );
    await store.insert(proposal({ proposalType: 'charter_update', votingState: 'open' }));
    expect(await store.listExecutable(now())).toHaveLength(1);
    expect(await store.listOpenByRoomAndType('r1', 'charter_update')).toHaveLength(1);
    expect((await store.listByRoom('r1', 50)).length).toBeGreaterThan(0);
    await expect(store.update(proposal({ proposalId: 'nope' }))).rejects.toThrow();
  });

  it('listRecoverableExecuting returns only STALE stranded `executing` proposals (H2/N2)', async () => {
    const store = new InMemoryGovernanceProposalStore();
    const cutoff = '2026-07-01T00:02:00.000Z';
    // Legacy null claim (pre-N2 stranded row) → always recoverable.
    await store.insert(
      proposal({ proposalId: 'legacy', votingState: 'passed', executionState: 'executing' }),
    );
    // Stranded with a claim OLDER than the cutoff → recoverable.
    await store.insert(
      proposal({
        proposalId: 'stale',
        votingState: 'passed',
        executionState: 'executing',
        executionClaimedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    // FRESH claim (NEWER than the cutoff) → a LIVE execution the sweep must NOT
    // race, else it would steal the `execution_simulated` audit attribution (N2).
    await store.insert(
      proposal({
        proposalId: 'fresh',
        votingState: 'passed',
        executionState: 'executing',
        executionClaimedAt: '2026-07-01T00:05:00.000Z',
      }),
    );
    // Already executed → NOT recoverable.
    await store.insert(
      proposal({ proposalId: 'done', votingState: 'passed', executionState: 'executed' }),
    );
    // Timelocked (not yet started) → belongs to listExecutable, not recovery.
    await store.insert(
      proposal({ proposalId: 'tl', votingState: 'passed', executionState: 'timelocked' }),
    );
    const recoverable = await store.listRecoverableExecuting(cutoff);
    expect(recoverable.map((r) => r.proposalId).sort()).toEqual(['legacy', 'stale']);
  });

  it('claimForExecution→executing then finalizeExecution→executed, each once (F10)', async () => {
    const store = new InMemoryGovernanceProposalStore();
    await store.insert(
      proposal({ proposalId: 'p', votingState: 'passed', executionState: 'timelocked' }),
    );
    const claimedAt = '2026-06-30T12:00:00.000Z';
    const claimed = await store.claimForExecution('p', claimedAt);
    expect(claimed?.executionState).toBe('executing'); // NOT executed (recoverable)
    expect(claimed?.executionClaimedAt).toBe(claimedAt); // stamps the recovery clock (N2)
    expect(await store.claimForExecution('p', claimedAt)).toBeNull(); // no double execution
    const finalized = await store.finalizeExecution('p', '2026-07-01T00:00:00.000Z');
    expect(finalized?.executionState).toBe('executed');
    expect(finalized?.executedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(await store.finalizeExecution('p', '2026-07-02T00:00:00.000Z')).toBeNull(); // no-op
  });

  it('resolveVotingIfOpen CAS open→terminal exactly once (F6)', async () => {
    const store = new InMemoryGovernanceProposalStore();
    await store.insert(proposal({ proposalId: 'p', votingState: 'open' }));
    const passed = await store.resolveVotingIfOpen('p', {
      votingState: 'passed',
      executionState: 'timelocked',
      executableAfter: '2026-07-01T00:00:00.000Z',
    });
    expect(passed?.votingState).toBe('passed');
    expect(passed?.executionState).toBe('timelocked');
    // A racer that tries to resolve again (or flip the outcome) loses the CAS.
    expect(await store.resolveVotingIfOpen('p', { votingState: 'rejected' })).toBeNull();
  });

  it('votes are insert-once and tally correctly (only while open)', async () => {
    const proposals = new InMemoryGovernanceProposalStore();
    await proposals.insert(proposal({ proposalId: 'p', votingState: 'open' }));
    const store = new InMemoryProposalVoteStore(proposals);
    expect(
      await store.cast({ proposalId: 'p', voterUserId: 'a', choice: 'approve', castAt: now() }),
    ).not.toBeNull();
    expect(
      await store.cast({ proposalId: 'p', voterUserId: 'a', choice: 'reject', castAt: now() }),
    ).toBeNull();
    await store.cast({ proposalId: 'p', voterUserId: 'b', choice: 'reject', castAt: now() });
    expect(await store.tally('p')).toEqual({ approve: 1, reject: 1, abstain: 0 });
  });

  it('cast REFUSES once the proposal is no longer open (F6)', async () => {
    const proposals = new InMemoryGovernanceProposalStore();
    await proposals.insert(proposal({ proposalId: 'closed', votingState: 'passed' }));
    const store = new InMemoryProposalVoteStore(proposals);
    expect(
      await store.cast({
        proposalId: 'closed',
        voterUserId: 'a',
        choice: 'approve',
        castAt: now(),
      }),
    ).toBeNull();
    // An absent proposal is likewise refused (fail-closed).
    expect(
      await store.cast({ proposalId: 'ghost', voterUserId: 'a', choice: 'approve', castAt: now() }),
    ).toBeNull();
  });

  it('signatures are insert-once per (proposal, wallet) and filter open', async () => {
    const proposals = new InMemoryGovernanceProposalStore();
    const openProposal = proposal({ votingState: 'open' });
    await proposals.insert(openProposal);
    const store = new InMemoryGovernanceSignatureStore(proposals);
    const sig = {
      signatureId: crypto.randomUUID(),
      proposalId: openProposal.proposalId,
      userId: 'u1',
      walletAccountId: 'w1',
      signatureType: 'eip712_ecdsa' as const,
      typedDataHash: '0xh',
      signatureRef: 'ref',
      weightSnapshot: null,
      eligibilityReason: 'member',
      createdAt: now(),
    };
    expect(await store.insert(sig)).toMatchObject({ ok: true });
    // A duplicate is `duplicate_signature`, NOT the delegated-unit refusal: the two
    // are different facts with different remedies, which is why `insert` reports a
    // reason instead of one null.
    expect(await store.insert({ ...sig, signatureId: crypto.randomUUID() })).toEqual({
      ok: false,
      reason: 'duplicate_signature',
    });
    expect(await store.listByProposal(openProposal.proposalId)).toHaveLength(1);
    expect(await store.listOpenByWallet('w1')).toHaveLength(1);
  });
});

describe('InMemorySimTreasuryStore + receipts + comprehension + deployments + mappings', () => {
  it('sim treasury upserts + appends entries', async () => {
    const store = new InMemorySimTreasuryStore();
    await store.put({ roomId: 'r1', balances: { 'SIM-USDC': '100' }, updatedAt: now() });
    await store.appendEntry({
      entryId: crypto.randomUUID(),
      roomId: 'r1',
      kind: 'deposit',
      asset: 'SIM-USDC',
      amount: '100',
      actorUserId: 'u1',
      proposalId: null,
      idempotencyKey: null,
      createdAt: now(),
    });
    expect((await store.get('r1'))?.balances['SIM-USDC']).toBe('100');
    expect(await store.listEntries('r1', 10)).toHaveLength(1);
  });

  it('put(record, expected, entry) commits balance + ledger atomically, idempotent by key (H8)', async () => {
    const store = new InMemorySimTreasuryStore();
    const seeded = await store.put({
      roomId: 'r1',
      balances: { 'SIM-USDC': '100' },
      updatedAt: now(),
    });
    expect(seeded).not.toBeNull();
    const key = 'idem-1';
    const entry = {
      entryId: crypto.randomUUID(),
      roomId: 'r1',
      kind: 'grant_execution' as const,
      asset: 'SIM-USDC',
      amount: '40',
      actorUserId: null,
      proposalId: 'p1',
      idempotencyKey: key,
      paymentIntentId: null,
      createdAt: now(),
    };
    // First write: balance changes AND the entry lands, together.
    const first = await store.put(
      {
        roomId: 'r1',
        balances: { 'SIM-USDC': '60' },
        updatedAt: new Date(Date.parse(now()) + 1).toISOString(),
      },
      seeded?.updatedAt,
      entry,
    );
    expect(first).not.toBeNull();
    expect((await store.get('r1'))?.balances['SIM-USDC']).toBe('60');
    expect(await store.findEntryByIdempotencyKey(key)).not.toBeNull();
    // A retry carrying the SAME entry key is a no-op: neither the balance nor the
    // ledger changes, and it still reports success (returns the current record).
    const retry = await store.put(
      {
        roomId: 'r1',
        balances: { 'SIM-USDC': '20' },
        updatedAt: new Date(Date.parse(now()) + 2).toISOString(),
      },
      (await store.get('r1'))?.updatedAt,
      { ...entry, entryId: crypto.randomUUID() },
    );
    expect(retry).not.toBeNull();
    expect((await store.get('r1'))?.balances['SIM-USDC']).toBe('60');
    expect(
      (await store.listEntries('r1', 10)).filter((e) => e.idempotencyKey === key),
    ).toHaveLength(1);
    expect(await store.findEntryByIdempotencyKey('missing')).toBeNull();
  });

  it('receipts upsert-by-action-kind and list public/private', async () => {
    const store = new InMemoryKnomosisReceiptStore();
    const base = {
      receiptId: crypto.randomUUID(),
      actionRecordId: 'a1',
      kind: 'public' as const,
      payload: { state: 'settled' },
      summaryPayloadHash: '0xh',
      ownerUserId: null,
      finalState: 'settled',
      createdAt: now(),
      updatedAt: now(),
    };
    await store.upsert(base);
    // A second upsert with the same (action, kind) updates in place.
    await store.upsert({ ...base, receiptId: crypto.randomUUID(), finalState: 'finalized' });
    expect((await store.getByAction('a1', 'public'))?.finalState).toBe('finalized');
    await store.upsert({
      ...base,
      kind: 'private',
      ownerUserId: 'u1',
      receiptId: crypto.randomUUID(),
    });
    expect(await store.listPrivateForUser('u1', 10)).toHaveLength(1);
    expect(await store.listPublicByRoomActions(['a1'])).toHaveLength(1);
    expect(await store.listPublicByRoomActions([])).toHaveLength(0);
  });

  it('comprehension is durable-pass and deployments upsert', async () => {
    const comp = new InMemoryComprehensionStore();
    await comp.record('u1', '1', false, now());
    await comp.record('u1', '1', true, now());
    // A later fail never revokes the pass.
    const after = await comp.record('u1', '1', false, now());
    expect(after.passed).toBe(true);
    expect(after.attempts).toBe(3);

    const deployments = new InMemoryKnomosisDeploymentStore();
    await deployments.upsert({
      deploymentId: 'd1',
      environment: 'local',
      chainId: 1,
      l1BridgeAddress: '0x1',
      runtimeEndpointRef: 'ref',
      contractManifestHash: '0x2',
      pinnedKnomosisCommit: 'abc',
      status: 'active',
      createdAt: now(),
    });
    expect(await deployments.getById('d1')).not.toBeNull();
    expect((await deployments.list()).length).toBe(1);

    const mappings = new InMemoryWalletActorMappingStore();
    await mappings.put({
      walletAccountId: 'w1',
      deploymentId: 'd1',
      actorId: '0xactor',
      createdAt: now(),
    });
    expect((await mappings.get('w1', 'd1'))?.actorId).toBe('0xactor');
    expect(await mappings.get('w1', 'd2')).toBeNull();
  });

  it('reconciliation keeps the latest-per-entity unresolved mismatch', async () => {
    const store = new InMemoryReconciliationStore();
    await store.append({
      resultId: crypto.randomUUID(),
      deploymentId: 'd1',
      entityType: 'action',
      entityRef: 'a1',
      outcome: 'mismatch',
      severity: 'warning',
      details: {},
      lowWatermarkSeq: '1',
      createdAt: '2026-07-06T00:00:00.000Z',
    });
    // A LATER match resolves it.
    await store.append({
      resultId: crypto.randomUUID(),
      deploymentId: 'd1',
      entityType: 'action',
      entityRef: 'a1',
      outcome: 'match',
      severity: null,
      details: {},
      lowWatermarkSeq: '2',
      createdAt: '2026-07-06T01:00:00.000Z',
    });
    expect(await store.listUnresolvedMismatches('d1')).toHaveLength(0);
    expect((await store.latestForEntity('action', 'a1'))?.outcome).toBe('match');
  });
});
