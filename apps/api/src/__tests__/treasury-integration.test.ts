// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres contract tests for the WS-M Drizzle treasury adapters —
// the same interfaces the in-memory adapters satisfy, against the REAL
// migration chain (0082's CHECKs, partial uniques, and append-only triggers):
// idempotency-key-as-record intent inserts, CAS state transitions, the
// one-reservation-per-proposal and one-active-delegation-per-scope uniques,
// the fork-proof hash-chained audit (one child per (room, prevHash), one
// genesis per room), and the WS-M casVotingState settle gate.  Run when
// DATABASE_URL is set (the CI test job provisions the service container).
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test

import { randomUUID } from 'node:crypto';
import {
  actionBudgets,
  createDbClient,
  delegationRecords,
  governanceChallenges,
  governanceProposals,
  governanceSignatures,
  knomosisActionRecords,
  knomosisDeployments,
  migrationsFolder,
  paymentIntents,
  roomGovernanceProfiles,
  roomReadinessAttestations,
  roomTreasuries,
  treasuryGrants,
  treasuryReservations,
  users,
  walletAccounts,
} from '@licio/db';
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DrizzleGovernanceAuditStore,
  DrizzleGovernanceProposalStore,
  DrizzleGovernanceSignatureStore,
  DrizzleKnomosisActionStore,
} from '../knomosis/drizzle-knomosis-stores.js';
import type { GovernanceAuditRecord, GovernanceProposalRecord } from '../knomosis/stores.js';
import { createDrizzleTreasuryStores } from '../treasury/drizzle-treasury-stores.js';
import type {
  GovernanceProfileRecord,
  PaymentIntentRecord,
  TreasuryRecord,
} from '../treasury/stores.js';

const DB_URL = process.env['DATABASE_URL'];
type Db = ReturnType<typeof createDbClient>;

const NOW = () => new Date().toISOString();
const HEX32 = (seed: string) => `0x${seed.repeat(64).slice(0, 64)}`;

async function makeUser(db: Db, handle: string): Promise<string> {
  const inserted = await db
    .insert(users)
    .values({
      handle: `${handle}_${randomUUID().slice(0, 8)}`,
      displayName: 'WS-M Integration',
      email: null,
      ageBandIfKnown: 'adult',
      privacySettings: defaultPrivacySettings(),
      personalizationSettings: defaultPersonalizationSettings(),
    })
    .returning();
  return (inserted[0] as { userId: string }).userId;
}

function proposalOf(roomId: string, userId: string): GovernanceProposalRecord {
  return {
    proposalId: randomUUID(),
    roomId,
    proposerUserId: userId,
    proposalType: 'capped_grant',
    title: 'WS-M contract fixture',
    plainLanguageSummary: 'A fixture proposal for the store contract.',
    requestedAmount: '1000',
    asset: 'USDC',
    recipientRef: 'fixture-recipient',
    conflictDisclosures: 'None.',
    riskAssessment: 'Low.',
    requestedAction: {},
    expectedDeliverable: 'Nothing.',
    preflightState: 'passed',
    votingState: 'open',
    challengeState: 'none',
    executionState: 'not_executed',
    simulationMode: false,
    executableAfter: null,
    createdAt: NOW(),
    executedAt: null,
    executionClaimedAt: null,
    lawPackVersionId: null,
    category: 'grant',
    deliberationEndsAt: null,
    votingEndsAt: NOW(),
    challengeWindowEndsAt: null,
    tallySnapshot: null,
  };
}

function treasuryOf(roomId: string, deploymentId: string): TreasuryRecord {
  return {
    treasuryId: randomUUID(),
    roomId,
    deploymentId,
    treasuryAddress: `0x${randomUUID().replaceAll('-', '')}${'0'.repeat(8)}`.toLowerCase(),
    acceptedAssets: ['USDC'],
    balanceSnapshot: null,
    balancesReconciledAt: null,
    depositLimits: {
      perUserPerPeriod: '100000000',
      perRoomPerPeriod: '1000000000',
      perDepositMax: '50000000',
      periodSeconds: 86_400,
    },
    freezeState: 'active',
    freezeReason: null,
    freezeCascade: false,
    pauseFlags: { deposits: false, proposals: false, executions: false },
    reconciliationState: 'pending',
    createdAt: NOW(),
  };
}

describe.skipIf(!DB_URL)('WS-M treasury Drizzle adapters (live Postgres)', () => {
  let db: Db;
  let stores: ReturnType<typeof createDrizzleTreasuryStores>;
  let proposals: DrizzleGovernanceProposalStore;
  let audit: DrizzleGovernanceAuditStore;
  const roomId = randomUUID();
  // A second room + actor, used only to prove the audit counters are scoped by
  // BOTH (a decoy that a room-blind or actor-blind predicate would swallow).
  const otherRoomId = randomUUID();
  const deploymentId = randomUUID();
  let userId: string;
  let otherUserId: string;
  let treasury: TreasuryRecord;
  const proposalIds: string[] = [];

  async function makeProposal(): Promise<string> {
    const record = proposalOf(roomId, userId);
    await proposals.insert(record);
    proposalIds.push(record.proposalId);
    return record.proposalId;
  }

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    stores = createDrizzleTreasuryStores(db);
    proposals = new DrizzleGovernanceProposalStore(db);
    audit = new DrizzleGovernanceAuditStore(db);
    userId = await makeUser(db, 'wsm_it');
    otherUserId = await makeUser(db, 'wsm_it_other');
    // A pinned deployment row (FK target for the treasury). A huge random
    // chain id dodges the (environment, chain) active-unique across runs.
    await db.insert(knomosisDeployments).values({
      deploymentId,
      environment: 'local',
      chainId: 100_000 + Math.floor(Math.random() * 800_000),
      l1BridgeAddress: `0x${'12'.repeat(20)}`,
      runtimeEndpointRef: 'config:wsm-itest',
      contractManifestHash: HEX32('a'),
      pinnedKnomosisCommit: 'c'.repeat(40),
      status: 'active',
    } as typeof knomosisDeployments.$inferInsert);
    treasury = treasuryOf(roomId, deploymentId);
    // The treasury ROW and its reconciled baseline are fixture state, not one
    // test's output: five later tests FK-reference `treasury.treasuryId` and the
    // nullable-column test reads this snapshot back to prove a `divergent` tick
    // preserves it.  Creating them here is what makes `-t '<name>'` usable on
    // each of those tests instead of failing with an opaque FK violation.  Both
    // are asserted so a broken adapter fails the fixture loudly rather than
    // twelve unrelated tests obscurely.
    expect(await stores.treasuries.insert(treasury)).not.toBeNull();
    expect(
      await stores.treasuries.setReconciliation(
        treasury.treasuryId,
        'synced',
        { USDC: '1500000' },
        NOW(),
      ),
    ).toBe(true);
  });

  /** Row-scoped delete from an append-only table (test cleanup only): the
   *  BEFORE DELETE trigger is disabled around the scoped delete so other rows
   *  in a shared dev database are never touched (TRUNCATE would be table-wide). */
  async function deleteAppendOnly(table: string, trigger: string, where: string): Promise<void> {
    await db.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER "${trigger}"`));
    try {
      await db.execute(sql.raw(`DELETE FROM ${table} WHERE ${where}`));
    } finally {
      await db.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER "${trigger}"`));
    }
  }

  afterAll(async () => {
    // FK-safe order: children first, soft-ref rows by roomId.  Charter,
    // snapshot, and chained-audit rows sit behind append-only triggers.
    await db.delete(roomReadinessAttestations).where(eq(roomReadinessAttestations.roomId, roomId));
    await deleteAppendOnly(
      '"knomosis"."treasury_reconciliation_snapshot"',
      'treasury_snapshot_no_mutate_trg',
      `treasury_id = '${treasury.treasuryId}'`,
    );
    if (proposalIds.length > 0) {
      await db
        .delete(governanceChallenges)
        .where(inArray(governanceChallenges.proposalId, proposalIds));
      await db.delete(treasuryGrants).where(inArray(treasuryGrants.proposalId, proposalIds));
      await db
        .delete(treasuryReservations)
        .where(inArray(treasuryReservations.proposalId, proposalIds));
    }
    await db.delete(delegationRecords).where(eq(delegationRecords.roomId, roomId));
    await db.delete(actionBudgets).where(eq(actionBudgets.roomId, roomId));
    await db.delete(paymentIntents).where(eq(paymentIntents.roomId, roomId));
    await db.delete(roomGovernanceProfiles).where(eq(roomGovernanceProfiles.roomId, roomId));
    await deleteAppendOnly(
      '"knomosis"."governance_charter_version"',
      'charter_version_no_mutate_trg',
      `room_id = '${roomId}'`,
    );
    await db.delete(roomTreasuries).where(eq(roomTreasuries.roomId, roomId));
    if (proposalIds.length > 0) {
      await db
        .delete(governanceProposals)
        .where(inArray(governanceProposals.proposalId, proposalIds));
    }
    await deleteAppendOnly(
      '"knomosis"."governance_audit_log"',
      'governance_audit_no_mutate_trg',
      `room_id IN ('${roomId}', '${otherRoomId}')`,
    );
    await db.delete(knomosisDeployments).where(eq(knomosisDeployments.deploymentId, deploymentId));
    await db.delete(users).where(inArray(users.userId, [userId, otherUserId]));
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  // --- Governance profile ----------------------------------------------------

  it('upserts + reads the governance profile in place', async () => {
    const record: GovernanceProfileRecord = {
      roomId,
      lawPackId: null,
      charterVersionId: null,
      treasuryId: null,
      quorumPolicyRef: null,
      thresholdPolicyRef: null,
      timelockPolicyRef: null,
      freezeState: 'active',
      freezeReason: null,
      pauseFlags: { deposits: false, proposals: false, executions: false },
      updatedAt: NOW(),
    };
    await stores.profiles.upsert(record);
    expect((await stores.profiles.get(roomId))?.freezeState).toBe('active');

    await stores.profiles.upsert({
      ...record,
      freezeState: 'frozen',
      freezeReason: 'contract test',
      pauseFlags: { deposits: true, proposals: false, executions: false },
      updatedAt: NOW(),
    });
    const frozen = await stores.profiles.get(roomId);
    expect(frozen?.freezeState).toBe('frozen');
    expect(frozen?.freezeReason).toBe('contract test');
    expect(frozen?.pauseFlags.deposits).toBe(true);
    expect((await stores.profiles.listAll()).some((p) => p.roomId === roomId)).toBe(true);
  });

  // --- Charters ----------------------------------------------------------------

  it('inserts charter versions and rejects a (room, version) collision', async () => {
    const sections = {
      purpose: 'p',
      decision_making: 'd',
      fund_management: 'f',
      member_rights: 'm',
      dispute_resolution: 'r',
      amendment_process: 'a',
      safety_override_acknowledgment: 's',
      appeals_path: 'x',
    };
    const v1 = {
      charterVersionId: randomUUID(),
      roomId,
      version: 1,
      sections,
      contentHash: HEX32('1'),
      createdByUserId: userId,
      createdAt: NOW(),
    };
    expect(await stores.charters.insert(v1)).not.toBeNull();
    // The (room, version) unique bites: a racing writer loses cleanly.
    expect(await stores.charters.insert({ ...v1, charterVersionId: randomUUID() })).toBeNull();
    expect(
      await stores.charters.insert({
        ...v1,
        charterVersionId: randomUUID(),
        version: 2,
        contentHash: HEX32('2'),
      }),
    ).not.toBeNull();
    expect((await stores.charters.latestByRoom(roomId))?.version).toBe(2);
    expect((await stores.charters.getById(v1.charterVersionId))?.version).toBe(1);
    expect(await stores.charters.listByRoom(roomId)).toHaveLength(2);
  });

  // --- Treasury ----------------------------------------------------------------

  it('inserts the treasury once per room/address and column-scopes updates', async () => {
    // One treasury per room (the fixture already inserted this room's).
    expect(await stores.treasuries.insert({ ...treasuryOf(roomId, deploymentId) })).toBeNull();
    // The address is globally unique.
    expect(
      await stores.treasuries.insert({
        ...treasuryOf(randomUUID(), deploymentId),
        treasuryAddress: treasury.treasuryAddress,
      }),
    ).toBeNull();

    expect(
      await stores.treasuries.setFreeze(treasury.treasuryId, 'frozen', 'divergence', false),
    ).toBe(true);
    expect(
      await stores.treasuries.setPauseFlags(treasury.treasuryId, {
        deposits: true,
        proposals: false,
        executions: false,
      }),
    ).toBe(true);
    const stored = await stores.treasuries.getById(treasury.treasuryId);
    expect(stored?.freezeState).toBe('frozen');
    expect(stored?.freezeReason).toBe('divergence');
    expect(stored?.pauseFlags.deposits).toBe(true);
    // Untouched by the freeze/pause writes above — each setter is column-scoped.
    expect(stored?.reconciliationState).toBe('synced');
    expect(stored?.balanceSnapshot).toEqual({ USDC: '1500000' });
    expect((await stores.treasuries.getByRoom(roomId))?.treasuryId).toBe(treasury.treasuryId);
    expect(
      (await stores.treasuries.listAll()).some((t) => t.treasuryId === treasury.treasuryId),
    ).toBe(true);
    // Unfreeze for the intent tests below.
    expect(await stores.treasuries.setFreeze(treasury.treasuryId, 'active', null, false)).toBe(
      true,
    );
  });

  // --- Reservations --------------------------------------------------------------

  it('holds ONE reservation per proposal and CAS-transitions its state', async () => {
    const proposalId = await makeProposal();
    const record = {
      reservationId: randomUUID(),
      treasuryId: treasury.treasuryId,
      proposalId,
      category: 'grant',
      asset: 'USDC',
      amount: '1000',
      state: 'reserved' as const,
      createdAt: NOW(),
      updatedAt: NOW(),
    };
    expect(await stores.reservations.insert(record)).not.toBeNull();
    // The partial unique bites: a second reservation for the SAME proposal loses.
    expect(await stores.reservations.insert({ ...record, reservationId: randomUUID() })).toBeNull();
    expect((await stores.reservations.getByProposal(proposalId))?.reservationId).toBe(
      record.reservationId,
    );

    const active = await stores.reservations.listActiveByTreasury(treasury.treasuryId, 'grant');
    expect(active.some((r) => r.reservationId === record.reservationId)).toBe(true);

    expect(
      await stores.reservations.transition(record.reservationId, 'reserved', 'consumed', NOW()),
    ).toBe(true);
    // The CAS loses on a repeat (stored state is no longer `reserved`).
    expect(
      await stores.reservations.transition(record.reservationId, 'reserved', 'released', NOW()),
    ).toBe(false);
    const consumed = await stores.reservations.listConsumedByTreasury(treasury.treasuryId, 'grant');
    expect(consumed.some((r) => r.reservationId === record.reservationId)).toBe(true);
  });

  // --- Payment intents -------------------------------------------------------------

  it('treats the idempotency unique as the record and CAS-transitions states', async () => {
    const idempotencyKey = randomUUID();
    const record: PaymentIntentRecord = {
      paymentIntentId: randomUUID(),
      userId,
      roomId,
      treasuryId: treasury.treasuryId,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '2500000',
      jurisdictionState: 'blocked',
      complianceState: 'pending',
      executionState: 'created',
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: null,
      idempotencyKey,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: NOW(),
      updatedAt: NOW(),
    };
    const inserted = await stores.intents.insert(record);
    expect(inserted.paymentIntentId).toBe(record.paymentIntentId);
    // A replay with the SAME (user, room, key) returns the EXISTING row.
    const replay = await stores.intents.insert({ ...record, paymentIntentId: randomUUID() });
    expect(replay.paymentIntentId).toBe(record.paymentIntentId);
    expect(
      (await stores.intents.findByIdempotencyKey(userId, roomId, idempotencyKey))?.paymentIntentId,
    ).toBe(record.paymentIntentId);

    const preflighted = await stores.intents.transition(
      record.paymentIntentId,
      'created',
      'preflighted',
      { jurisdictionState: 'allowed', complianceState: 'cleared' },
      NOW(),
    );
    expect(preflighted?.executionState).toBe('preflighted');
    expect(preflighted?.jurisdictionState).toBe('allowed');
    // The CAS loses when the stored state moved on.
    expect(
      await stores.intents.transition(record.paymentIntentId, 'created', 'quoted', {}, NOW()),
    ).toBeNull();
    const quoted = await stores.intents.transition(
      record.paymentIntentId,
      'preflighted',
      'quoted',
      { quoteRef: { estimated_fee: '1000' } },
      NOW(),
    );
    expect(quoted?.quoteRef).toEqual({ estimated_fee: '1000' });

    expect(
      (await stores.intents.listByRoom(roomId, 10)).some(
        (i) => i.paymentIntentId === record.paymentIntentId,
      ),
    ).toBe(true);
    expect(
      (await stores.intents.listByStates(['quoted'], 10)).some(
        (i) => i.paymentIntentId === record.paymentIntentId,
      ),
    ).toBe(true);
    // Keyset paging (W5 review): an afterId cursor excludes rows at/below it.
    expect(
      (await stores.intents.listByStates(['quoted'], 10, record.paymentIntentId)).some(
        (i) => i.paymentIntentId === record.paymentIntentId,
      ),
    ).toBe(false);

    // ROOM-owned scope (W5 review): user_id NULL dedupes on (room, key) via
    // the 0083 partial unique index — the insert collision returns the row.
    const roomKey = randomUUID();
    const roomOwned: PaymentIntentRecord = {
      ...record,
      paymentIntentId: randomUUID(),
      userId: null,
      targetType: 'grant_payout',
      targetId: randomUUID(),
      idempotencyKey: roomKey,
    };
    const roomInserted = await stores.intents.insert(roomOwned);
    expect(roomInserted.paymentIntentId).toBe(roomOwned.paymentIntentId);
    const roomReplay = await stores.intents.insert({ ...roomOwned, paymentIntentId: randomUUID() });
    expect(roomReplay.paymentIntentId).toBe(roomOwned.paymentIntentId);
    expect(
      (await stores.intents.findByIdempotencyKey(null, roomId, roomKey))?.paymentIntentId,
    ).toBe(roomOwned.paymentIntentId);
  });

  it('lists only timed-out PRE-SUBMISSION intents as expired', async () => {
    const expired: PaymentIntentRecord = {
      paymentIntentId: randomUUID(),
      userId,
      roomId,
      treasuryId: treasury.treasuryId,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '100',
      jurisdictionState: 'blocked',
      complianceState: 'pending',
      executionState: 'created',
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: null,
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: NOW(),
      updatedAt: NOW(),
    };
    await stores.intents.insert(expired);
    const listed = await stores.intents.listExpired(NOW(), 50);
    expect(listed.some((i) => i.paymentIntentId === expired.paymentIntentId)).toBe(true);
    // A post-submission state never appears in the expiry sweep.
    await stores.intents.transition(expired.paymentIntentId, 'created', 'preflighted', {}, NOW());
    await stores.intents.transition(expired.paymentIntentId, 'preflighted', 'quoted', {}, NOW());
    await stores.intents.transition(expired.paymentIntentId, 'quoted', 'signed', {}, NOW());
    await stores.intents.transition(expired.paymentIntentId, 'signed', 'submitted', {}, NOW());
    const relisted = await stores.intents.listExpired(NOW(), 50);
    expect(relisted.some((i) => i.paymentIntentId === expired.paymentIntentId)).toBe(false);
  });

  it('listActiveByUser excludes REORGED intents (W14: the transfer reversed)', async () => {
    const owner = await makeUser(db, 'wsm_reorg');
    const intentOf = (executionState: 'confirmed' | 'reorged'): PaymentIntentRecord => ({
      paymentIntentId: randomUUID(),
      userId: owner,
      roomId,
      treasuryId: treasury.treasuryId,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '100',
      jurisdictionState: 'allowed',
      complianceState: 'cleared',
      executionState,
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: null,
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: NOW(),
      updatedAt: NOW(),
    });
    await stores.intents.insert(intentOf('reorged'));
    const confirmed = await stores.intents.insert(intentOf('confirmed'));
    const active = await stores.intents.listActiveByUser(owner, 10);
    expect(active.map((i) => i.paymentIntentId)).toEqual([confirmed.paymentIntentId]);
    await db.delete(paymentIntents).where(eq(paymentIntents.userId, owner));
    await db.delete(users).where(eq(users.userId, owner));
  });

  it('getByPaymentIntentId recovers a room-owned steward action, LIVE-only (W14 auto-attach)', async () => {
    const actions = new DrizzleKnomosisActionStore(db);
    const steward = await makeUser(db, 'wsm_stew_a');
    const inserted = await db
      .insert(walletAccounts)
      .values({
        userId: steward,
        addressHash: Buffer.from(randomUUID().replaceAll('-', ''), 'hex'),
        addressTruncated: '0xabcd…ef01',
        chainId: 1337,
        walletType: 'eoa' as const,
        unlinkState: 'active' as const,
        riskState: 'normal' as const,
      })
      .returning();
    const wallet = (inserted[0] as { walletAccountId: string }).walletAccountId;
    const intentId = randomUUID();
    const actionOf = (state: 'submitted' | 'failed') => ({
      actionRecordId: randomUUID(),
      deploymentId,
      actionType: 'grant_payout' as const,
      roomId,
      actorWalletAccountId: wallet,
      actorUserId: steward,
      payloadHash: HEX32('1'),
      typedDataHash: `0x${randomUUID().replaceAll('-', '')}${'0'.repeat(32)}`,
      signedAction: { message: { amount: '10', asset: 'USDC' }, signature: '0xsig' },
      submissionState: state,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending' as const,
      // A room-owned payout carries the steward's OWN client idempotency key —
      // the intent↔action link is `payment_intent_id`, not the key (W14).
      idempotencyKey: randomUUID(),
      paymentIntentId: intentId,
      createdAt: NOW(),
      updatedAt: NOW(),
    });
    // A dead prior attempt for the SAME intent stays invisible; the live action
    // is recovered regardless of which steward's key it carries.
    const dead = actionOf('failed');
    await actions.insert(dead);
    expect(await actions.getByPaymentIntentId(intentId)).toBeNull();
    const live = actionOf('submitted');
    await actions.insert(live);
    expect((await actions.getByPaymentIntentId(intentId))?.actionRecordId).toBe(
      live.actionRecordId,
    );
    await db.delete(knomosisActionRecords).where(eq(knomosisActionRecords.roomId, roomId));
    await db.delete(walletAccounts).where(eq(walletAccounts.userId, steward));
    await db.delete(users).where(eq(users.userId, steward));
  });

  it('round-trips a delegated ballot’s CONSUMED delegator set (migration 0105)', async () => {
    // The in-memory store keeps the whole record, so it cannot tell whether the
    // Drizzle adapter actually writes and reads the column — exactly the shape
    // of no-op that has shipped here before.  Only a live round-trip can.
    const signatures = new DrizzleGovernanceSignatureStore(db);
    const signer = await makeUser(db, 'wsm_sig_a');
    const delegatorA = randomUUID();
    const delegatorB = randomUUID();
    const inserted = await db
      .insert(walletAccounts)
      .values({
        userId: signer,
        addressHash: Buffer.from(randomUUID().replaceAll('-', ''), 'hex'),
        addressTruncated: '0xfeed…beef',
        chainId: 1337,
        walletType: 'eoa' as const,
        unlinkState: 'active' as const,
        riskState: 'normal' as const,
      })
      .returning();
    const walletAccountId = (inserted[0] as { walletAccountId: string }).walletAccountId;
    const proposalId = await makeProposal();
    const base = {
      proposalId,
      userId: signer,
      walletAccountId,
      signatureType: 'eip712_ecdsa' as const,
      typedDataHash: HEX32('d'),
      signatureRef: `0x${'ab'.repeat(32)}`,
      weightSnapshot: '2',
      eligibilityReason: 'Delegated: own vote + 2 eligible delegations (1) capped at 2.',
      createdAt: NOW(),
      choice: 'approve' as const,
      nonce: randomUUID(),
    };
    expect(
      await signatures.insert({
        ...base,
        signatureId: randomUUID(),
        purpose: 'vote',
        countedDelegatorIds: [delegatorA, delegatorB],
      }),
    ).not.toBeNull();
    const [voteRow] = await signatures.listByProposal(proposalId);
    expect(voteRow?.countedDelegatorIds).toEqual([delegatorA, delegatorB]);
    // A model that folds no delegations records NULL, and the reader must not
    // turn that into an empty set — "not recorded" and "consumed nothing" are
    // different answers, and the consumption guard branches on which it is.
    expect(
      await signatures.insert({
        ...base,
        signatureId: randomUUID(),
        purpose: 'approval',
        nonce: randomUUID(),
        countedDelegatorIds: null,
      }),
    ).not.toBeNull();
    const rows = await signatures.listByProposal(proposalId);
    expect(rows.find((r) => r.purpose === 'approval')?.countedDelegatorIds ?? null).toBeNull();
    await db.delete(governanceSignatures).where(eq(governanceSignatures.proposalId, proposalId));
    await db.delete(walletAccounts).where(eq(walletAccounts.userId, signer));
    await db.delete(users).where(eq(users.userId, signer));
  });

  // --- Grants ----------------------------------------------------------------------

  it('creates ONE grant per proposal and round-trips milestone updates', async () => {
    const proposalId = await makeProposal();
    const milestoneId = randomUUID();
    const record = {
      grantId: randomUUID(),
      roomId,
      treasuryId: treasury.treasuryId,
      proposalId,
      recipientRef: 'fixture-recipient',
      purpose: 'Contract test grant',
      amount: '1000',
      asset: 'USDC',
      milestones: [
        {
          milestoneId,
          description: 'All of it',
          amount: '1000',
          state: 'pending' as const,
          paymentIntentId: null,
        },
      ],
      milestoneState: 'pending' as const,
      reviewState: 'pending' as const,
      payoutState: 'not_started' as const,
      auditSummary: null,
      createdAt: NOW(),
    };
    expect(await stores.grants.insert(record)).not.toBeNull();
    expect(await stores.grants.insert({ ...record, grantId: randomUUID() })).toBeNull();
    expect((await stores.grants.getByProposal(proposalId))?.grantId).toBe(record.grantId);

    const [firstMilestone] = record.milestones;
    if (firstMilestone === undefined) throw new Error('fixture milestone missing');
    const updated = await stores.grants.update({
      ...record,
      milestones: [{ ...firstMilestone, state: 'accepted' }],
      milestoneState: 'accepted',
      reviewState: 'cleared',
      payoutState: 'paid',
    });
    expect(updated?.payoutState).toBe('paid');
    const roundTrip = await stores.grants.getById(record.grantId);
    expect(roundTrip?.milestones[0]?.state).toBe('accepted');
    expect(
      (await stores.grants.listByRoom(roomId, 10)).some((g) => g.grantId === record.grantId),
    ).toBe(true);
  });

  // --- Action budgets -----------------------------------------------------------------

  it('guards budget writes with the optimistic updatedAt', async () => {
    const record = {
      budgetId: randomUUID(),
      roomId,
      actorKey: `user:${userId}`,
      availableUnits: 10,
      lastRefillAt: NOW(),
      rateLimitState: null,
      updatedAt: NOW(),
    };
    // Insert-only (expected null) succeeds once…
    expect(await stores.budgets.put(record, null)).not.toBeNull();
    // …and loses on a repeat insert-only write (the row exists).
    expect(await stores.budgets.put({ ...record, budgetId: randomUUID() }, null)).toBeNull();

    const stored = await stores.budgets.get(roomId, `user:${userId}`);
    expect(stored?.availableUnits).toBe(10);
    // A stale expectedUpdatedAt loses; the fresh one wins.
    const charged = {
      ...(stored as NonNullable<typeof stored>),
      availableUnits: 9,
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    };
    expect(await stores.budgets.put(charged, '1999-01-01T00:00:00.000Z')).toBeNull();
    expect(
      await stores.budgets.put(charged, (stored as NonNullable<typeof stored>).updatedAt),
    ).not.toBeNull();
    expect((await stores.budgets.get(roomId, `user:${userId}`))?.availableUnits).toBe(9);
  });

  // --- Delegations -----------------------------------------------------------------------

  it('enforces one ACTIVE delegation per (room, delegator, scope)', async () => {
    const delegateId = await makeUser(db, 'wsm_delegate');
    try {
      const record = {
        delegationId: randomUUID(),
        roomId,
        delegatorUserId: userId,
        delegateUserId: delegateId,
        scope: { all: true } as const,
        scopeKey: 'all',
        state: 'active' as const,
        createdAt: NOW(),
        revokedAt: null,
      };
      expect(await stores.delegations.insert(record)).not.toBeNull();
      // The partial unique bites while the first is active…
      expect(await stores.delegations.insert({ ...record, delegationId: randomUUID() })).toBeNull();
      expect(
        (await stores.delegations.listActiveByDelegate(roomId, delegateId)).some(
          (d) => d.delegationId === record.delegationId,
        ),
      ).toBe(true);
      expect(
        (await stores.delegations.listActiveByDelegator(roomId, userId)).some(
          (d) => d.delegationId === record.delegationId,
        ),
      ).toBe(true);

      const revoked = await stores.delegations.revoke(record.delegationId, NOW());
      expect(revoked?.state).toBe('revoked');
      // …and releases after revocation.
      expect(
        await stores.delegations.insert({ ...record, delegationId: randomUUID() }),
      ).not.toBeNull();
      expect((await stores.delegations.listByRoom(roomId, 10)).length).toBeGreaterThanOrEqual(2);
    } finally {
      await db.delete(delegationRecords).where(eq(delegationRecords.roomId, roomId));
      await db.delete(users).where(eq(users.userId, delegateId));
    }
  });

  // --- Challenges -----------------------------------------------------------------------

  it('CAS-resolves challenges per the pure table', async () => {
    const proposalId = await makeProposal();
    const record = {
      challengeId: randomUUID(),
      proposalId,
      challengerUserId: userId,
      challengeType: 'coi' as const,
      description: 'Quorum math looks off.',
      evidenceRefs: [],
      state: 'open' as const,
      resolutionNote: null,
      resolvedByUserId: null,
      createdAt: NOW(),
      resolvedAt: null,
    };
    await stores.challenges.insert(record);
    expect(await stores.challenges.countOpenByProposal(proposalId)).toBe(1);

    const upheld = await stores.challenges.transition(record.challengeId, 'open', 'upheld', {
      note: 'Confirmed.',
      resolvedByUserId: userId,
      resolvedAt: NOW(),
    });
    expect(upheld?.state).toBe('upheld');
    expect(upheld?.resolutionNote).toBe('Confirmed.');
    // The CAS loses once the challenge left `open`.
    expect(
      await stores.challenges.transition(record.challengeId, 'open', 'dismissed', {
        note: null,
        resolvedByUserId: userId,
        resolvedAt: NOW(),
      }),
    ).toBeNull();
    expect(await stores.challenges.countOpenByProposal(proposalId)).toBe(0);
    expect((await stores.challenges.listByProposal(proposalId))[0]?.challengeId).toBe(
      record.challengeId,
    );
  });

  // --- Reconciliation snapshots -------------------------------------------------------------

  it('appends snapshots and serves the newest per (treasury, asset)', async () => {
    const base = {
      treasuryId: treasury.treasuryId,
      asset: 'USDC',
      productLedgerBalance: '100',
      receiptsBalance: '100',
      onchainObservedBalance: '100',
      gap: '0',
      explanation: null,
      result: 'synced' as const,
    };
    await stores.snapshots.append({
      ...base,
      snapshotId: randomUUID(),
      observedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const newest = await stores.snapshots.append({
      ...base,
      snapshotId: randomUUID(),
      productLedgerBalance: '200',
      result: 'divergent',
      explanation: { kind: 'gap' },
      observedAt: NOW(),
    });
    const latest = await stores.snapshots.latestByTreasuryAsset(treasury.treasuryId, 'USDC');
    expect(latest?.snapshotId).toBe(newest.snapshotId);
    expect(latest?.result).toBe('divergent');
    expect(await stores.snapshots.listByTreasury(treasury.treasuryId, 10)).toHaveLength(2);
  });

  // --- Attestations ------------------------------------------------------------------------

  it('upserts attestations in place per (room, item)', async () => {
    await stores.attestations.upsert({
      roomId,
      item: 'external_audit_passed',
      attestedByUserId: userId,
      note: 'v1',
      createdAt: NOW(),
    });
    await stores.attestations.upsert({
      roomId,
      item: 'external_audit_passed',
      attestedByUserId: userId,
      note: 'v2',
      createdAt: NOW(),
    });
    expect((await stores.attestations.get(roomId, 'external_audit_passed'))?.note).toBe('v2');
    expect(await stores.attestations.get(roomId, 'safety_override_acknowledged')).toBeNull();
  });

  // --- The hash-chained audit (evolved knomosis store, migration 0082) ----------------------

  it('appends the chained audit fork-proof: one genesis, one child per prevHash', async () => {
    const genesis = await audit.appendChained({
      entryId: randomUUID(),
      roomId,
      actionType: 'treasury_created',
      actorUserId: userId,
      actionDetails: { step: 'genesis' },
      simulationMode: false,
      createdAt: NOW(),
      prevHash: null,
      integrityHash: HEX32('d'),
    });
    expect(genesis).not.toBeNull();
    // A second GENESIS for the same room loses (one chain per room).
    expect(
      await audit.appendChained({
        entryId: randomUUID(),
        roomId,
        actionType: 'treasury_created',
        actorUserId: userId,
        actionDetails: { step: 'genesis-dup' },
        simulationMode: false,
        createdAt: NOW(),
        prevHash: null,
        integrityHash: HEX32('e'),
      }),
    ).toBeNull();

    expect((await audit.chainHead(roomId))?.integrityHash).toBe(HEX32('d'));

    const child = await audit.appendChained({
      entryId: randomUUID(),
      roomId,
      actionType: 'payment_intent_created',
      actorUserId: userId,
      actionDetails: { step: 'child' },
      simulationMode: false,
      createdAt: NOW(),
      prevHash: HEX32('d'),
      integrityHash: HEX32('f'),
    });
    expect(child).not.toBeNull();
    // A FORK (second child of the same parent) loses.
    expect(
      await audit.appendChained({
        entryId: randomUUID(),
        roomId,
        actionType: 'payment_intent_created',
        actorUserId: userId,
        actionDetails: { step: 'fork' },
        simulationMode: false,
        createdAt: NOW(),
        prevHash: HEX32('d'),
        integrityHash: HEX32('0'),
      }),
    ).toBeNull();

    expect((await audit.chainHead(roomId))?.integrityHash).toBe(HEX32('f'));
    expect(await audit.listChainedByRoom(roomId)).toHaveLength(2);
  });

  // --- Non-null mapping arms + scoped-type delegations -------------------------

  it('round-trips non-null optional columns across the mapping layer', async () => {
    // A grant milestone carrying its payment-intent linkage.
    const proposalId = await makeProposal();
    const intent: PaymentIntentRecord = {
      paymentIntentId: randomUUID(),
      userId,
      roomId,
      treasuryId: treasury.treasuryId,
      targetType: 'grant_payout',
      targetId: proposalId,
      asset: 'USDC',
      amount: '10',
      jurisdictionState: 'allowed',
      complianceState: 'cleared',
      executionState: 'created',
      retryCount: 1,
      quoteRef: { estimated_fee: '5' },
      actionRecordId: null,
      receiptId: null,
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: NOW(),
      updatedAt: NOW(),
    };
    await stores.intents.insert(intent);
    const stored = await stores.intents.getById(intent.paymentIntentId);
    expect(stored?.quoteRef).toEqual({ estimated_fee: '5' });
    expect(stored?.retryCount).toBe(1);

    const milestoneId = randomUUID();
    const grant = await stores.grants.insert({
      grantId: randomUUID(),
      roomId,
      treasuryId: treasury.treasuryId,
      proposalId,
      recipientRef: 'coop',
      purpose: 'Linked milestone',
      amount: '10',
      asset: 'USDC',
      milestones: [
        {
          milestoneId,
          description: 'All',
          amount: '10',
          state: 'accepted',
          paymentIntentId: intent.paymentIntentId,
        },
      ],
      milestoneState: 'accepted',
      reviewState: 'cleared',
      payoutState: 'scheduled',
      auditSummary: 'ok',
      createdAt: NOW(),
    });
    expect(grant?.milestones[0]?.paymentIntentId).toBe(intent.paymentIntentId);
    expect((await stores.grants.getById(grant?.grantId ?? ''))?.auditSummary).toBe('ok');

    // A budget carrying rate-limit state.
    const budget = await stores.budgets.put(
      {
        budgetId: randomUUID(),
        roomId,
        actorKey: 'workflow:report',
        availableUnits: 3,
        lastRefillAt: NOW(),
        rateLimitState: { burst: 2 },
        updatedAt: NOW(),
      },
      null,
    );
    expect(budget?.rateLimitState).toEqual({ burst: 2 });

    // A TYPE-scoped delegation (the non-`all` scope arm).
    const scoped = await stores.delegations.insert({
      delegationId: randomUUID(),
      roomId,
      delegatorUserId: userId,
      delegateUserId: userId,
      scope: { proposal_type: 'capped_grant' },
      scopeKey: 'type:capped_grant',
      state: 'active',
      createdAt: NOW(),
      revokedAt: null,
    });
    expect(scoped?.scope).toEqual({ proposal_type: 'capped_grant' });
    expect((await stores.delegations.getById(scoped?.delegationId ?? ''))?.scopeKey).toBe(
      'type:capped_grant',
    );
  });

  it('round-trips the remaining nullable-column arms', async () => {
    // Profile with non-null policy refs + a law-pack-free charter link.
    await stores.profiles.upsert({
      roomId,
      lawPackId: null,
      charterVersionId: null,
      treasuryId: treasury.treasuryId,
      quorumPolicyRef: { rule: 'fraction', v: '0.2' },
      thresholdPolicyRef: { rule: 'strict-majority' },
      timelockPolicyRef: { seconds: 3600 },
      freezeState: 'active',
      freezeReason: null,
      pauseFlags: { deposits: false, proposals: false, executions: false },
      updatedAt: NOW(),
    });
    const profile = await stores.profiles.get(roomId);
    expect(profile?.quorumPolicyRef).toEqual({ rule: 'fraction', v: '0.2' });
    expect(profile?.treasuryId).toBe(treasury.treasuryId);

    // Charter row whose author was erased (created_by null arm).
    const anonymous = await stores.charters.insert({
      charterVersionId: randomUUID(),
      roomId,
      version: 99,
      sections: {
        purpose: 'p',
        decision_making: 'd',
        fund_management: 'f',
        member_rights: 'm',
        dispute_resolution: 'r',
        amendment_process: 'a',
        safety_override_acknowledgment: 's',
        appeals_path: 'x',
      } as never,
      contentHash: HEX32('9'),
      createdByUserId: null,
      createdAt: NOW(),
    });
    expect(anonymous?.createdByUserId).toBeNull();

    // A divergent tick passes null and PRESERVES the last-reconciled snapshot
    // (the dashboard keeps showing last-reconciled balances, WS-M.2.2c).
    await stores.treasuries.setReconciliation(treasury.treasuryId, 'divergent', null, null);
    const divergent = await stores.treasuries.getById(treasury.treasuryId);
    expect(divergent?.reconciliationState).toBe('divergent');
    expect(divergent?.balanceSnapshot).toEqual({ USDC: '1500000' });
    expect(divergent?.balancesReconciledAt).not.toBeNull();

    // A challenge carrying evidence refs (the non-empty array arm).
    const proposalId = await makeProposal();
    const withEvidence = await stores.challenges.insert({
      challengeId: randomUUID(),
      proposalId,
      challengerUserId: null,
      challengeType: 'fraud',
      description: 'Evidence attached.',
      evidenceRefs: ['story:abc', 'comment:def'],
      state: 'open',
      resolutionNote: null,
      resolvedByUserId: null,
      createdAt: NOW(),
      resolvedAt: null,
    });
    expect(withEvidence.evidenceRefs).toEqual(['story:abc', 'comment:def']);
    expect(
      (await stores.challenges.getById(withEvidence.challengeId))?.challengerUserId,
    ).toBeNull();

    // Attestation with an erased attester (null arm).
    await stores.attestations.upsert({
      roomId,
      item: 'safety_override_acknowledged',
      attestedByUserId: null,
      note: 'acknowledged',
      createdAt: NOW(),
    });
    expect(
      (await stores.attestations.get(roomId, 'safety_override_acknowledged'))?.attestedByUserId,
    ).toBeNull();

    // Intent expiresAt patch arm + a user-erased intent read (userId null arm).
    const intent: PaymentIntentRecord = {
      paymentIntentId: randomUUID(),
      userId: null,
      roomId,
      treasuryId: treasury.treasuryId,
      targetType: 'steward_compensation',
      targetId: randomUUID(),
      asset: 'USDC',
      amount: '1',
      jurisdictionState: 'restricted',
      complianceState: 'flagged',
      executionState: 'created',
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: null,
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: NOW(),
      updatedAt: NOW(),
    };
    await stores.intents.insert(intent);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const patched = await stores.intents.transition(
      intent.paymentIntentId,
      'created',
      'preflighted',
      { expiresAt: later },
      NOW(),
    );
    expect(patched?.expiresAt).toBe(later);
    expect(patched?.userId).toBeNull();
  });

  it('claims, finalizes, and lists executable proposals atomically (Drizzle CAS)', async () => {
    const proposalId = await makeProposal();
    const past = new Date(Date.now() - 60_000).toISOString();
    const settled = await proposals.casVotingState(proposalId, 'open', 'passed', {
      executionState: 'timelocked',
      executableAfter: past,
      tallySnapshot: { outcome: 'passed' },
    });
    expect(settled?.executionState).toBe('timelocked');

    const executable = await proposals.listExecutable(NOW());
    expect(executable.some((p) => p.proposalId === proposalId)).toBe(true);

    const claimed = await proposals.claimForExecution(proposalId, NOW());
    expect(claimed?.executionState).toBe('executing');
    // A racing claim loses cleanly.
    expect(await proposals.claimForExecution(proposalId, NOW())).toBeNull();

    const finalized = await proposals.finalizeExecution(proposalId, NOW());
    expect(finalized?.executionState).toBe('executed');
    expect(await proposals.finalizeExecution(proposalId, NOW())).toBeNull();

    // Whole-record update round-trips the WS-M columns.
    const updated = await proposals.update({
      ...(finalized as NonNullable<typeof finalized>),
      challengeState: 'dismissed',
    });
    expect(updated.challengeState).toBe('dismissed');
    expect((await proposals.listByRoom(roomId, 100)).some((p) => p.proposalId === proposalId)).toBe(
      true,
    );
  });

  it('dedupes plain audit appends by key and counts actor participation', async () => {
    const dedupeKey = `wsm-itest:${randomUUID()}`;
    const entry = {
      entryId: randomUUID(),
      roomId,
      actionType: 'proposal_published' as const,
      actorUserId: userId,
      actionDetails: { via: 'itest' },
      simulationMode: false,
      createdAt: NOW(),
      dedupeKey,
    };
    await audit.append(entry);
    // The idempotency-key arm: a replay is a NO-OP, never a duplicate row.
    await audit.append({ ...entry, entryId: randomUUID() });
    const listed = await audit.listByRoom(roomId, 100);
    // The projection omits dedupeKey; the details payload identifies the row.
    expect(listed.filter((e) => e.actionDetails['via'] === 'itest')).toHaveLength(1);
    expect(await audit.countByRoom(roomId)).toBeGreaterThan(0);

    // `countQualifyingByRoomActor` feeds `memberFacts.contributionCount`, which
    // gates the `minContributions` eligibility rule — a predicate that silently
    // returns 0 disenfranchises every member of a room with a contributions
    // threshold.  Seed one row per arm of it: room, actor, and qualifying action
    // type, plus the deliberate NON-arm — unlike the room-scoped sibling it does
    // NOT filter `simulationMode`, because simulated practice IS the record the
    // readiness rule counts.  The `proposal_published` row appended above is the
    // non-qualifying decoy for this same (room, actor).
    const qualifying = (over: Partial<GovernanceAuditRecord> = {}) =>
      audit.append({
        entryId: randomUUID(),
        roomId,
        actionType: 'vote_cast',
        actorUserId: userId,
        actionDetails: {},
        simulationMode: false,
        createdAt: NOW(),
        ...over,
      });
    await qualifying();
    await qualifying({ actionType: 'proposal_created' });
    await qualifying({ simulationMode: true });
    await qualifying({ actorUserId: otherUserId }); // another actor, same room
    await qualifying({ roomId: otherRoomId }); // same actor, another room
    expect(await audit.countQualifyingByRoomActor(roomId, userId)).toBe(3);
    expect(await audit.countQualifyingByRoomActor(roomId, otherUserId)).toBe(1);
    expect(await audit.countQualifyingByRoomActor(otherRoomId, userId)).toBe(1);
    // The room-scoped sibling DOES demand `simulation_mode` — pinning the
    // asymmetry from both sides, since either query drifting toward the other
    // is one of the ways this silently returns the wrong number.
    expect(await audit.countQualifyingByRoom(roomId)).toBe(1);

    // Cursor-paged read (the keyset arm).
    const newest = listed[0];
    if (newest !== undefined) {
      const page = await audit.listByRoom(roomId, 10, {
        createdAt: newest.createdAt,
        entryId: newest.entryId,
      });
      expect(page.every((e) => e.entryId !== newest.entryId)).toBe(true);
    }

    // Last, so it perturbs none of the arms above: right-to-erasure NULLs
    // `actor_user_id` in place (the rows survive; only the attribution goes), so
    // the actor count must follow it to zero rather than keep matching a stale
    // predicate on the erased id.
    expect(await audit.anonymizeActor(userId)).toBeGreaterThan(0);
    expect(await audit.countQualifyingByRoomActor(roomId, userId)).toBe(0);
    expect(await audit.countByRoom(roomId)).toBeGreaterThan(0);
  });

  it('W3 surfaces: keyset pages, period deposits, per-asset reservations, unsettled query', async () => {
    // Keyset pagination over the treasury history is complete and duplicate-free.
    const pageIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const record: PaymentIntentRecord = {
        paymentIntentId: randomUUID(),
        userId,
        roomId,
        treasuryId: treasury.treasuryId,
        targetType: 'treasury_deposit',
        targetId: treasury.treasuryId,
        asset: 'USDC',
        amount: '1',
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
      };
      await stores.intents.insert(record);
      pageIds.push(record.paymentIntentId);
    }
    const walked: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await stores.intents.listByTreasuryPage(treasury.treasuryId, after, 2);
      walked.push(...page.map((r) => r.paymentIntentId));
      if (page.length < 2) break;
      after = page[page.length - 1]?.paymentIntentId ?? null;
    }
    for (const id of pageIds) expect(walked).toContain(id);
    expect(new Set(walked).size).toBe(walked.length);

    // The in-period deposit aggregate sees every deposit-class row.
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const deposits = await stores.intents.listDepositsInPeriod(roomId, since);
    expect(deposits.length).toBeGreaterThanOrEqual(3);
    expect(deposits.every((d) => d.targetType !== 'grant_payout')).toBe(true);

    // Per-asset open reservations across categories.
    const proposalId = await makeProposal();
    await stores.reservations.insert({
      reservationId: randomUUID(),
      treasuryId: treasury.treasuryId,
      proposalId,
      category: 'bounty',
      asset: 'USDC',
      amount: '3',
      state: 'reserved',
      createdAt: NOW(),
      updatedAt: NOW(),
    });
    const open = await stores.reservations.listActiveByTreasuryAsset(treasury.treasuryId, 'USDC');
    expect(open.some((r) => r.proposalId === proposalId)).toBe(true);

    // The unsettled query returns live production work only.
    const unsettled = await proposals.listUnsettledByRoom(roomId, 100);
    expect(unsettled.every((p) => !p.simulationMode)).toBe(true);
    expect(
      unsettled.every(
        (p) =>
          p.votingState === 'deliberation' ||
          p.votingState === 'open' ||
          (p.votingState === 'passed' &&
            (p.executionState === 'timelocked' || p.executionState === 'executing')),
      ),
    ).toBe(true);
    expect(unsettled.some((p) => p.proposalId === proposalId)).toBe(true);
  });

  // --- casVotingState (evolved knomosis proposal store) --------------------------------------

  it('settles a proposal exactly once via the casVotingState gate', async () => {
    const proposalId = await makeProposal();
    const settled = await proposals.casVotingState(proposalId, 'open', 'passed', {
      tallySnapshot: { outcome: 'passed', approve: '2', reject: '0' },
      executionState: 'timelocked',
      executableAfter: NOW(),
      challengeWindowEndsAt: NOW(),
    });
    expect(settled?.votingState).toBe('passed');
    expect(settled?.executionState).toBe('timelocked');
    expect(settled?.tallySnapshot).toMatchObject({ outcome: 'passed' });
    // A racing settle loses: the stored state is no longer `open`.
    expect(await proposals.casVotingState(proposalId, 'open', 'rejected', {})).toBeNull();
  });
});
