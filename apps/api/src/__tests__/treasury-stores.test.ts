// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The in-memory WS-M store adapters: the SAME contract the Drizzle adapters
// prove against live Postgres (treasury-integration.test.ts) — unique-as-null
// inserts, CAS transitions that lose cleanly, idempotency-key-as-record intent
// inserts, and the list projections the services depend on.  Keeping the two
// adapter families behaviourally identical is what makes the dev/test path a
// faithful stand-in for production (check:prod-parity's runtime counterpart).

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type ChallengeRecord,
  type DelegationRecordEntity,
  type GrantRecord,
  InMemoryActionBudgetStore,
  InMemoryAttestationStore,
  InMemoryChallengeStore,
  InMemoryCharterStore,
  InMemoryDelegationStore,
  InMemoryGovernanceProfileStore,
  InMemoryGrantStore,
  InMemoryPaymentIntentStore,
  InMemoryReservationStore,
  InMemorySnapshotStore,
  InMemoryTreasuryStore,
  type PaymentIntentRecord,
  type ReservationRecord,
  type TreasuryRecord,
} from '../treasury/stores.js';

const ROOM = '77777777-7777-4777-8777-777777777777';
const USER = '88888888-8888-4888-8888-888888888888';
const NOW = () => new Date().toISOString();

function treasuryOf(over: Partial<TreasuryRecord> = {}): TreasuryRecord {
  return {
    treasuryId: randomUUID(),
    roomId: ROOM,
    deploymentId: randomUUID(),
    treasuryAddress: `0x${randomUUID().replaceAll('-', '')}${'0'.repeat(8)}`.toLowerCase(),
    acceptedAssets: ['USDC'],
    balanceSnapshot: null,
    balancesReconciledAt: null,
    depositLimits: {
      perUserPerPeriod: '100',
      perRoomPerPeriod: '1000',
      perDepositMax: '50',
      periodSeconds: 86_400,
    },
    freezeState: 'active',
    freezeReason: null,
    pauseFlags: { deposits: false, proposals: false, executions: false },
    reconciliationState: 'pending',
    createdAt: NOW(),
    ...over,
  };
}

function intentOf(over: Partial<PaymentIntentRecord> = {}): PaymentIntentRecord {
  return {
    paymentIntentId: randomUUID(),
    userId: USER,
    roomId: ROOM,
    treasuryId: randomUUID(),
    targetType: 'treasury_deposit',
    targetId: randomUUID(),
    asset: 'USDC',
    amount: '10',
    jurisdictionState: 'blocked',
    complianceState: 'pending',
    executionState: 'created',
    retryCount: 0,
    quoteRef: null,
    actionRecordId: null,
    receiptId: null,
    idempotencyKey: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: NOW(),
    updatedAt: NOW(),
    ...over,
  };
}

describe('in-memory WS-M stores (the Drizzle contract, no I/O)', () => {
  it('treasury: one per room, one per address, column-scoped updates', async () => {
    const store = new InMemoryTreasuryStore();
    const record = treasuryOf();
    expect(await store.insert(record)).not.toBeNull();
    expect(await store.insert(treasuryOf())).toBeNull(); // same room
    expect(
      await store.insert(
        treasuryOf({ roomId: randomUUID(), treasuryAddress: record.treasuryAddress }),
      ),
    ).toBeNull(); // same address
    expect(await store.setFreeze(record.treasuryId, 'frozen', 'why')).toBe(true);
    expect(await store.setFreeze(randomUUID(), 'frozen', null)).toBe(false);
    expect(await store.setReconciliation(record.treasuryId, 'synced', { USDC: '5' }, NOW())).toBe(
      true,
    );
    const stored = await store.getById(record.treasuryId);
    expect(stored?.freezeState).toBe('frozen');
    expect(stored?.balanceSnapshot).toEqual({ USDC: '5' });
    expect((await store.getByRoom(ROOM))?.treasuryId).toBe(record.treasuryId);
    expect(await store.listAll()).toHaveLength(1);
  });

  it('charters: (room, version) unique; latest + history', async () => {
    const store = new InMemoryCharterStore();
    const base = {
      charterVersionId: randomUUID(),
      roomId: ROOM,
      version: 1,
      sections: {} as never,
      contentHash: `0x${'1'.repeat(64)}`,
      createdByUserId: USER,
      createdAt: NOW(),
    };
    expect(await store.insert(base)).not.toBeNull();
    expect(await store.insert({ ...base, charterVersionId: randomUUID() })).toBeNull();
    expect(
      await store.insert({ ...base, charterVersionId: randomUUID(), version: 2 }),
    ).not.toBeNull();
    expect((await store.latestByRoom(ROOM))?.version).toBe(2);
    expect(await store.listByRoom(ROOM)).toHaveLength(2);
    expect((await store.getById(base.charterVersionId))?.version).toBe(1);
  });

  it('reservations: one per proposal; CAS; active/consumed projections', async () => {
    const store = new InMemoryReservationStore();
    const record: ReservationRecord = {
      reservationId: randomUUID(),
      treasuryId: 't-1',
      proposalId: randomUUID(),
      category: 'grant',
      asset: 'USDC',
      amount: '5',
      state: 'reserved',
      createdAt: NOW(),
      updatedAt: NOW(),
    };
    expect(await store.insert(record)).not.toBeNull();
    expect(await store.insert({ ...record, reservationId: randomUUID() })).toBeNull();
    expect(await store.listActiveByTreasury('t-1', 'grant')).toHaveLength(1);
    expect(await store.transition(record.reservationId, 'reserved', 'consumed', NOW())).toBe(true);
    expect(await store.transition(record.reservationId, 'reserved', 'released', NOW())).toBe(false);
    // Reserved and consumed stay DISJOINT — headroom subtracts both, so a
    // consumed row appearing in the active list would double-count it.
    expect(await store.listActiveByTreasury('t-1', 'grant')).toHaveLength(0);
    expect(await store.listConsumedByTreasury('t-1', 'grant')).toHaveLength(1);
  });

  it('intents: the idempotency key IS the record; CAS; expiry/state lists', async () => {
    const store = new InMemoryPaymentIntentStore();
    const record = intentOf({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect((await store.insert(record)).paymentIntentId).toBe(record.paymentIntentId);
    const replay = await store.insert({ ...record, paymentIntentId: randomUUID() });
    expect(replay.paymentIntentId).toBe(record.paymentIntentId);
    expect(
      (await store.findByIdempotencyKey(USER, ROOM, record.idempotencyKey))?.paymentIntentId,
    ).toBe(record.paymentIntentId);
    expect(await store.listExpired(NOW(), 10)).toHaveLength(1);
    const moved = await store.transition(
      record.paymentIntentId,
      'created',
      'preflighted',
      { jurisdictionState: 'allowed' },
      NOW(),
    );
    expect(moved?.jurisdictionState).toBe('allowed');
    expect(
      await store.transition(record.paymentIntentId, 'created', 'quoted', {}, NOW()),
    ).toBeNull();
    expect(await store.listByStates(['preflighted'], 10)).toHaveLength(1);
    expect(await store.listByRoom(ROOM, 10)).toHaveLength(1);
  });

  it('grants: one per proposal; whole-record update round-trips', async () => {
    const store = new InMemoryGrantStore();
    const record: GrantRecord = {
      grantId: randomUUID(),
      roomId: ROOM,
      treasuryId: 't-1',
      proposalId: randomUUID(),
      recipientRef: 'coop',
      purpose: 'Survey',
      amount: '10',
      asset: 'USDC',
      milestones: [],
      milestoneState: 'pending',
      reviewState: 'pending',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: NOW(),
    };
    expect(await store.insert(record)).not.toBeNull();
    expect(await store.insert({ ...record, grantId: randomUUID() })).toBeNull();
    expect((await store.update({ ...record, payoutState: 'paid' }))?.payoutState).toBe('paid');
    expect(await store.update({ ...record, grantId: randomUUID() })).toBeNull();
    expect((await store.getByProposal(record.proposalId))?.payoutState).toBe('paid');
    expect(await store.listByRoom(ROOM, 10)).toHaveLength(1);
  });

  it('budgets: optimistic put (insert-only, stale-guard, fresh write)', async () => {
    const store = new InMemoryActionBudgetStore();
    const record = {
      budgetId: randomUUID(),
      roomId: ROOM,
      actorKey: `user:${USER}`,
      availableUnits: 10,
      lastRefillAt: NOW(),
      rateLimitState: null,
      updatedAt: NOW(),
    };
    expect(await store.put(record, null)).not.toBeNull();
    expect(await store.put({ ...record, budgetId: randomUUID() }, null)).toBeNull();
    expect(await store.put({ ...record, availableUnits: 9 }, 'wrong')).toBeNull();
    expect(await store.put({ ...record, availableUnits: 9 }, record.updatedAt)).not.toBeNull();
    expect((await store.get(ROOM, `user:${USER}`))?.availableUnits).toBe(9);
  });

  it('delegations: one ACTIVE per (room, delegator, scope); revoke releases', async () => {
    const store = new InMemoryDelegationStore();
    const record: DelegationRecordEntity = {
      delegationId: randomUUID(),
      roomId: ROOM,
      delegatorUserId: USER,
      delegateUserId: randomUUID(),
      scope: { all: true },
      scopeKey: 'all',
      state: 'active',
      createdAt: NOW(),
      revokedAt: null,
    };
    expect(await store.insert(record)).not.toBeNull();
    expect(await store.insert({ ...record, delegationId: randomUUID() })).toBeNull();
    expect(await store.listActiveByDelegate(ROOM, record.delegateUserId as string)).toHaveLength(1);
    expect(await store.listActiveByDelegator(ROOM, USER)).toHaveLength(1);
    expect((await store.revoke(record.delegationId, NOW()))?.state).toBe('revoked');
    expect(await store.revoke(randomUUID(), NOW())).toBeNull();
    expect(await store.insert({ ...record, delegationId: randomUUID() })).not.toBeNull();
    expect(await store.listByRoom(ROOM, 10)).toHaveLength(2);
  });

  it('challenges: CAS resolution; open count', async () => {
    const store = new InMemoryChallengeStore();
    const record: ChallengeRecord = {
      challengeId: randomUUID(),
      proposalId: randomUUID(),
      challengerUserId: USER,
      challengeType: 'coi',
      description: 'Undisclosed conflict.',
      evidenceRefs: [],
      state: 'open',
      resolutionNote: null,
      resolvedByUserId: null,
      createdAt: NOW(),
      resolvedAt: null,
    };
    await store.insert(record);
    expect(await store.countOpenByProposal(record.proposalId)).toBe(1);
    const upheld = await store.transition(record.challengeId, 'open', 'upheld', {
      note: 'Confirmed.',
      resolvedByUserId: USER,
      resolvedAt: NOW(),
    });
    expect(upheld?.state).toBe('upheld');
    expect(
      await store.transition(record.challengeId, 'open', 'dismissed', {
        note: null,
        resolvedByUserId: USER,
        resolvedAt: NOW(),
      }),
    ).toBeNull();
    expect(await store.countOpenByProposal(record.proposalId)).toBe(0);
    expect(await store.listByProposal(record.proposalId)).toHaveLength(1);
  });

  it('snapshots: append-only; newest per (treasury, asset)', async () => {
    const store = new InMemorySnapshotStore();
    const base = {
      treasuryId: 't-1',
      asset: 'USDC',
      productLedgerBalance: '1',
      receiptsBalance: '1',
      onchainObservedBalance: '1',
      gap: '0',
      explanation: null,
      result: 'synced' as const,
    };
    await store.append({
      ...base,
      snapshotId: randomUUID(),
      observedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const newest = await store.append({
      ...base,
      snapshotId: randomUUID(),
      result: 'divergent',
      observedAt: NOW(),
    });
    expect((await store.latestByTreasuryAsset('t-1', 'USDC'))?.snapshotId).toBe(newest.snapshotId);
    expect(await store.latestByTreasuryAsset('t-1', 'OTHER')).toBeNull();
    expect(await store.listByTreasury('t-1', 10)).toHaveLength(2);
  });

  it('profiles + attestations: upsert-in-place semantics', async () => {
    const profiles = new InMemoryGovernanceProfileStore();
    const base = {
      roomId: ROOM,
      lawPackId: null,
      charterVersionId: null,
      treasuryId: null,
      quorumPolicyRef: null,
      thresholdPolicyRef: null,
      timelockPolicyRef: null,
      freezeState: 'active' as const,
      freezeReason: null,
      pauseFlags: { deposits: false, proposals: false, executions: false },
      updatedAt: NOW(),
    };
    await profiles.upsert(base);
    await profiles.upsert({ ...base, freezeState: 'frozen' });
    expect((await profiles.get(ROOM))?.freezeState).toBe('frozen');
    expect(await profiles.listAll()).toHaveLength(1);

    const attestations = new InMemoryAttestationStore();
    await attestations.upsert({
      roomId: ROOM,
      item: 'external_audit_passed',
      attestedByUserId: USER,
      note: 'v1',
      createdAt: NOW(),
    });
    await attestations.upsert({
      roomId: ROOM,
      item: 'external_audit_passed',
      attestedByUserId: USER,
      note: 'v2',
      createdAt: NOW(),
    });
    expect((await attestations.get(ROOM, 'external_audit_passed'))?.note).toBe('v2');
    expect(await attestations.get(ROOM, 'safety_override_acknowledged')).toBeNull();
  });
});

describe('clear() (interface parity: every adapter resets for tests)', () => {
  it('empties every in-memory store', async () => {
    const treasuries = new InMemoryTreasuryStore();
    await treasuries.insert(treasuryOf());
    const intents = new InMemoryPaymentIntentStore();
    await intents.insert(intentOf());
    const charters = new InMemoryCharterStore();
    const profiles = new InMemoryGovernanceProfileStore();
    const reservations = new InMemoryReservationStore();
    const grants = new InMemoryGrantStore();
    const budgets = new InMemoryActionBudgetStore();
    const delegations = new InMemoryDelegationStore();
    const challenges = new InMemoryChallengeStore();
    const snapshots = new InMemorySnapshotStore();
    const attestations = new InMemoryAttestationStore();
    for (const store of [
      treasuries,
      intents,
      charters,
      profiles,
      reservations,
      grants,
      budgets,
      delegations,
      challenges,
      snapshots,
      attestations,
    ]) {
      await store.clear();
    }
    expect(await treasuries.listAll()).toHaveLength(0);
    expect(await intents.listByRoom(ROOM, 10)).toHaveLength(0);
    expect(await profiles.listAll()).toHaveLength(0);
  });
});
