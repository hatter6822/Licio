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

  it('claimForExecution→executing then finalizeExecution→executed, each once (F10)', async () => {
    const store = new InMemoryGovernanceProposalStore();
    await store.insert(
      proposal({ proposalId: 'p', votingState: 'passed', executionState: 'timelocked' }),
    );
    const claimed = await store.claimForExecution('p');
    expect(claimed?.executionState).toBe('executing'); // NOT executed (recoverable)
    expect(await store.claimForExecution('p')).toBeNull(); // no double execution
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
    expect(await store.insert(sig)).not.toBeNull();
    expect(await store.insert({ ...sig, signatureId: crypto.randomUUID() })).toBeNull(); // dup
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
      createdAt: now(),
    });
    expect((await store.get('r1'))?.balances['SIM-USDC']).toBe('100');
    expect(await store.listEntries('r1', 10)).toHaveLength(1);
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
