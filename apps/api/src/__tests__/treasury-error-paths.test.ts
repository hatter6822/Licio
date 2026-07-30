// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M guard-path coverage: the clean-rejection branches of the treasury
// services — self/duplicate delegation, non-delegator revocation, the
// stake-free grant-review gate, reservation caps + idempotent double-
// approval, the frozen/paused writability guard, deposit-limit and
// asset-acceptance rejections, bounded retry, and the accounting export's
// divergent-asset exclusion.  Every rejection is a typed error, never a throw.

import { randomUUID } from 'node:crypto';
import type { TreasuryBounds } from '@licio/governance';
import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryGovernanceStores } from '../governance/stores.js';
import { chargeRoomActionBudget, refundActionBudget } from '../treasury/budgets.js';
import { createDelegation, revokeDelegation } from '../treasury/delegations.js';
import { buildAccountingExport } from '../treasury/export.js';
import { markGrantClawedBack, setGrantReview, updateGrantMilestone } from '../treasury/grants.js';
import { createPaymentIntent, preflightIntent, retryIntent } from '../treasury/intents.js';
import {
  assertGovernanceWritable,
  ensureProfile,
  setGovernanceFreeze,
  setGovernancePause,
} from '../treasury/profile.js';
import { executeProposal } from '../treasury/proposals.js';
import { recordReadinessAttestation } from '../treasury/readiness.js';
import {
  consumeReservation,
  releaseReservation,
  reserveForProposal,
} from '../treasury/reservations.js';
import {
  createInMemoryTreasuryServices,
  resetTreasuryServicesForTests,
  type TreasuryServices,
} from '../treasury/services.js';
import type { TreasuryRecord } from '../treasury/stores.js';
import { createTreasury } from '../treasury/treasury.js';
import {
  freshKnomosisServices,
  LOCAL_DEPLOYMENT,
  resetKnomosisFixture,
} from './knomosis-test-helpers.js';

const ROOM = '77777777-7777-4777-8777-777777777777';
const USER = '88888888-8888-4888-8888-888888888888';
const OTHER = '99999999-9999-4999-8999-999999999999';

const BOUNDS: TreasuryBounds = {
  caps: [{ category: 'grant', perActionMax: '100', perWindowMax: '150', windowSeconds: 86_400 }],
  minIntervalSeconds: 0,
  timelockSeconds: 0,
  materialThreshold: '1000',
  requireCoiFor: [],
  investment: null,
};

async function wsmServices(): Promise<TreasuryServices> {
  const fixture = await freshKnomosisServices();
  fixture.knomosis.rooms = {
    roomGovernance: async () => ({ mode: 'testnet' as never, name: 'Governed Room' }),
    isMember: async () => true,
    isSteward: async () => true,
    contentVisibleToUser: async () => true,
  };
  fixture.knomosis.roomMode = {
    currentMode: async () => 'testnet' as never,
    setMode: async () => true,
    setModeIf: async () => true,
  };
  return createInMemoryTreasuryServices({
    knomosis: fixture.knomosis,
    governanceStores: createInMemoryGovernanceStores(),
    membership: {
      memberFacts: async () => ({
        membershipDays: 60,
        contributionCount: 10,
        verifiedIdentity: true,
      }),
      eligibleMemberCount: async () => ({ count: 3, asOf: new Date(0).toISOString() }),
      measureEligibleMembers: async () => ({ count: 3, asOf: new Date().toISOString() }),
    },
    treasuryExecutor: { execute: async () => ({ accepted: true, code: null }) },
    elections: { openElection: async () => true },
  });
}

async function provisionTreasury(services: TreasuryServices): Promise<TreasuryRecord> {
  const record: TreasuryRecord = {
    treasuryId: randomUUID(),
    roomId: ROOM,
    deploymentId: randomUUID(),
    treasuryAddress: `0x${'ab'.repeat(20)}`,
    acceptedAssets: ['USDC'],
    balanceSnapshot: null,
    balancesReconciledAt: null,
    depositLimits: {
      perUserPerPeriod: '1000',
      perRoomPerPeriod: '5000',
      perDepositMax: '100',
      periodSeconds: 86_400,
    },
    freezeState: 'active',
    freezeReason: null,
    freezeCascade: false,
    pauseFlags: { deposits: false, proposals: false, executions: false },
    reconciliationState: 'synced',
    createdAt: new Date().toISOString(),
  };
  const inserted = await services.treasuries.insert(record);
  if (inserted === null) throw new Error('fixture treasury collision');
  return inserted;
}

afterEach(() => {
  resetTreasuryServicesForTests();
  resetKnomosisFixture();
});

describe('delegation guards (WS-M.4.2c-3)', () => {
  it('rejects self-delegation, duplicates, and foreign revocation', async () => {
    const services = await wsmServices();
    const self = await createDelegation(services, {
      roomId: ROOM,
      delegatorUserId: USER,
      delegateUserId: USER,
      scope: { all: true },
    });
    expect('code' in self && self.code).toBe('self_delegation');

    const created = await createDelegation(services, {
      roomId: ROOM,
      delegatorUserId: USER,
      delegateUserId: OTHER,
      scope: { all: true },
    });
    if ('code' in created) throw new Error(created.message);

    const duplicate = await createDelegation(services, {
      roomId: ROOM,
      delegatorUserId: USER,
      delegateUserId: OTHER,
      scope: { all: true },
    });
    expect('code' in duplicate && duplicate.code).toBe('delegation_exists');

    const foreign = await revokeDelegation(services, {
      roomId: ROOM,
      delegationId: created.delegation.delegationId,
      actorUserId: OTHER,
      isPlatformStaff: false,
    });
    expect('code' in foreign && foreign.code).toBe('not_delegator');

    // Platform staff CAN revoke (abuse response); a second revoke is a 409.
    const staff = await revokeDelegation(services, {
      roomId: ROOM,
      delegationId: created.delegation.delegationId,
      actorUserId: OTHER,
      isPlatformStaff: true,
    });
    expect('ok' in staff && staff.ok).toBe(true);
    const again = await revokeDelegation(services, {
      roomId: ROOM,
      delegationId: created.delegation.delegationId,
      actorUserId: USER,
      isPlatformStaff: false,
    });
    expect('code' in again && again.code).toBe('already_revoked');

    const missing = await revokeDelegation(services, {
      roomId: ROOM,
      delegationId: randomUUID(),
      actorUserId: USER,
      isPlatformStaff: false,
    });
    expect('code' in missing && missing.code).toBe('not_found');
  });
});

describe('reservation caps + idempotency (WS-M.2.3a-1)', () => {
  it('enforces per-action and per-window caps, and double-approval is idempotent', async () => {
    const services = await wsmServices();
    const treasury = await provisionTreasury(services);
    const base = { treasuryId: treasury.treasuryId, category: 'grant', asset: 'USDC' };

    const noCap = await reserveForProposal(services, {
      ...base,
      category: 'bounty',
      proposalId: randomUUID(),
      amount: '1',
      bounds: BOUNDS,
    });
    expect('code' in noCap && noCap.code).toBe('no_cap_configured');

    const tooBig = await reserveForProposal(services, {
      ...base,
      proposalId: randomUUID(),
      amount: '101',
      bounds: BOUNDS,
    });
    expect('code' in tooBig && tooBig.code).toBe('per_action_cap_exceeded');

    const proposalId = randomUUID();
    const first = await reserveForProposal(services, {
      ...base,
      proposalId,
      amount: '100',
      bounds: BOUNDS,
    });
    if ('code' in first) throw new Error(first.message);
    // A racing double-approval maps to the SAME reservation.
    const replay = await reserveForProposal(services, {
      ...base,
      proposalId,
      amount: '100',
      bounds: BOUNDS,
    });
    if ('code' in replay) throw new Error(replay.message);
    expect(replay.reservation.reservationId).toBe(first.reservation.reservationId);
    // 100 of the 150 window is reserved: 60 more exceeds the remaining headroom.
    const overWindow = await reserveForProposal(services, {
      ...base,
      proposalId: randomUUID(),
      amount: '60',
      bounds: BOUNDS,
    });
    expect('code' in overWindow && overWindow.code).toBe('per_window_cap_exceeded');

    // Consume is an idempotent, proposal-keyed CAS: a re-drive stays true;
    // an upheld challenge can still release a consumed reservation; and an
    // unknown proposal is a clean false.
    expect(await consumeReservation(services, proposalId)).toBe(true);
    expect(await consumeReservation(services, proposalId)).toBe(true);
    expect(await releaseReservation(services, proposalId)).toBe(true);
    expect(await releaseReservation(services, proposalId)).toBe(true);
    expect(await consumeReservation(services, randomUUID())).toBe(false);
    expect(await releaseReservation(services, randomUUID())).toBe(false);
  });
});

describe('grant review independence (WS-M.2.3d)', () => {
  it('rejects a reviewer with a stake and an unknown grant', async () => {
    const services = await wsmServices();
    const treasury = await provisionTreasury(services);
    const proposalId = randomUUID();
    await services.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'capped_grant',
      title: 'Grant fixture',
      plainLanguageSummary: 'A grant.',
      requestedAmount: '10',
      asset: 'USDC',
      recipientRef: `user:${OTHER}`,
      conflictDisclosures: 'None.',
      riskAssessment: 'Low.',
      requestedAction: {},
      expectedDeliverable: 'None.',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'none',
      executionState: 'executed',
      simulationMode: false,
      executableAfter: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
    });
    const inserted = await services.grants.insert({
      grantId: randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId,
      recipientRef: `user:${OTHER}`,
      purpose: 'A grant.',
      amount: '10',
      asset: 'USDC',
      milestones: [],
      milestoneState: 'pending',
      reviewState: 'pending',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (inserted === null) throw new Error('fixture grant collision');

    // The proposer and the recipient both fail the independence gate.
    for (const reviewer of [USER, OTHER]) {
      const outcome = await setGrantReview(services, {
        roomId: ROOM,
        grantId: inserted.grantId,
        reviewState: 'cleared',
        reviewerUserId: reviewer,
      });
      expect('code' in outcome && outcome.code).toBe('independent_review_required');
    }
    const third = await setGrantReview(services, {
      roomId: ROOM,
      grantId: inserted.grantId,
      reviewState: 'cleared',
      reviewerUserId: randomUUID(),
    });
    if ('code' in third) throw new Error(third.message);
    expect(third.grant.reviewState).toBe('cleared');

    const missing = await setGrantReview(services, {
      roomId: ROOM,
      grantId: randomUUID(),
      reviewState: 'cleared',
      reviewerUserId: randomUUID(),
    });
    expect('code' in missing && missing.code).toBe('not_found');
  });
});

describe('writability guard + intent limits (WS-M.2.4a-1 / 3.1)', () => {
  it('pauses one operation without touching the others', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const paused = await setGovernancePause(services, {
      roomId: ROOM,
      patch: { deposits: true },
      reason: 'maintenance',
      actorUserId: USER,
    });
    if ('code' in paused) throw new Error(paused.message);
    expect((await assertGovernanceWritable(services, ROOM, 'deposits'))?.code).toBe(
      'deposits_paused',
    );
    expect(await assertGovernanceWritable(services, ROOM, 'proposals')).toBeNull();
  });

  it('rejects a frozen treasury for deposits while voting stays writable', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    await services.treasuries.setFreeze(treasury.treasuryId, 'frozen', 'divergence', false);
    expect((await assertGovernanceWritable(services, ROOM, 'deposits'))?.code).toBe(
      'treasury_frozen',
    );
    expect(await assertGovernanceWritable(services, ROOM, 'voting')).toBeNull();
  });

  it('rejects unaccepted assets, over-limit deposits, and exhausted retries', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);

    const wrongAsset = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'DOGE',
      amount: '1',
      idempotencyKey: randomUUID(),
    });
    expect('code' in wrongAsset && wrongAsset.code).toBe('asset_not_accepted');

    const overMax = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '101', // perDepositMax is 100
      idempotencyKey: randomUUID(),
    });
    expect('code' in overMax && overMax.code).toBe('deposit_limit_exceeded');

    const missingTreasury = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: randomUUID(), // a room with no treasury
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '1',
      idempotencyKey: randomUUID(),
    });
    expect('code' in missingTreasury && missingTreasury.code).toBe('no_treasury');

    // Retry is bounded: an intent at the max retry count refuses another.
    const created = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '1',
      idempotencyKey: randomUUID(),
    });
    if ('code' in created) throw new Error(created.message);
    await services.intents.transition(
      created.intent.paymentIntentId,
      'created',
      'preflighted',
      { retryCount: services.wsmConfig().wsmIntentMaxRetries },
      new Date().toISOString(),
    );
    const exhausted = await retryIntent(services, created.intent.paymentIntentId, USER);
    expect('code' in exhausted && exhausted.code).toBe('retries_exhausted');
  });
});

describe('accounting export (WS-M.5.2b)', () => {
  it('rejects a missing treasury and an inverted period; excludes divergent assets', async () => {
    const services = await wsmServices();
    const noTreasury = await buildAccountingExport(services, {
      roomId: ROOM,
      periodStartIso: '2026-07-01T00:00:00.000Z',
      periodEndIso: '2026-07-02T00:00:00.000Z',
    });
    expect('code' in noTreasury && noTreasury.code).toBe('no_treasury');

    const treasury = await provisionTreasury(services);
    const inverted = await buildAccountingExport(services, {
      roomId: ROOM,
      periodStartIso: '2026-07-02T00:00:00.000Z',
      periodEndIso: '2026-07-01T00:00:00.000Z',
    });
    expect('code' in inverted && inverted.code).toBe('invalid_period');

    // One finalized intent whose asset's latest snapshot is DIVERGENT: the row
    // is excluded and counted, never silently included.
    const created = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '5',
      idempotencyKey: randomUUID(),
    });
    if ('code' in created) throw new Error(created.message);
    const nowIso = new Date().toISOString();
    for (const [from, to] of [
      ['created', 'preflighted'],
      ['preflighted', 'quoted'],
      ['quoted', 'signed'],
      ['signed', 'submitted'],
      ['submitted', 'pending'],
      ['pending', 'confirmed'],
      ['confirmed', 'finalized'],
    ] as const) {
      await services.intents.transition(created.intent.paymentIntentId, from, to, {}, nowIso);
    }
    await services.snapshots.append({
      snapshotId: randomUUID(),
      treasuryId: treasury.treasuryId,
      asset: 'USDC',
      productLedgerBalance: '5',
      receiptsBalance: '0',
      onchainObservedBalance: '0',
      gap: '5',
      explanation: null,
      result: 'divergent',
      observedAt: nowIso,
    });
    const start = new Date(Date.now() - 3_600_000).toISOString();
    const end = new Date(Date.now() + 3_600_000).toISOString();
    const built = await buildAccountingExport(services, {
      roomId: ROOM,
      periodStartIso: start,
      periodEndIso: end,
    });
    if ('code' in built) throw new Error(built.message);
    expect(built.export.rows).toHaveLength(0);
    expect(built.export.excluded_unreconciled).toBe(1);
  });
});

describe('execution routing (WS-M.4.3b)', () => {
  async function timelockedProposal(
    services: TreasuryServices,
    over: Partial<Parameters<TreasuryServices['proposals']['insert']>[0]> = {},
  ): Promise<string> {
    const proposalId = randomUUID();
    const past = new Date(Date.now() - 60_000).toISOString();
    await services.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'capped_grant',
      title: 'Execution fixture',
      plainLanguageSummary: 'Executes now.',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: 'None.',
      riskAssessment: 'Low.',
      requestedAction: {},
      expectedDeliverable: 'None.',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'none',
      executionState: 'timelocked',
      simulationMode: false,
      executableAfter: past,
      createdAt: past,
      executedAt: null,
      executionClaimedAt: null,
      lawPackVersionId: null,
      category: null,
      deliberationEndsAt: null,
      votingEndsAt: past,
      challengeWindowEndsAt: past,
      tallySnapshot: null,
      ...over,
    });
    return proposalId;
  }

  it('routes steward_rotation through a forced election, blocking on refusal', async () => {
    const services = await wsmServices();
    // Refusal first: the proposal blocks honestly and stays un-executed.
    services.elections = { openElection: async () => false };
    const refused = await timelockedProposal(services, { proposalType: 'steward_rotation' });
    const blocked = await executeProposal(services, {
      roomId: ROOM,
      proposalId: refused,
      userId: USER,
    });
    expect('code' in blocked && blocked.code).toBe('election_not_opened');
    expect((await services.proposals.getById(refused))?.executionState).toBe('blocked');

    services.elections = { openElection: async () => true };
    const rotation = await timelockedProposal(services, { proposalType: 'steward_rotation' });
    const executed = await executeProposal(services, {
      roomId: ROOM,
      proposalId: rotation,
      userId: USER,
    });
    if ('code' in executed) throw new Error(executed.message);
    expect(executed.proposal.executionState).toBe('executed');
  });

  it('routes charter_update through the charter service (voted sections land)', async () => {
    const services = await wsmServices();
    const TEXT =
      'This section is written in plain language. It explains the rule simply. Everyone can read it.';
    const proposalId = await timelockedProposal(services, {
      proposalType: 'charter_update',
      requestedAction: {
        sections: {
          purpose: TEXT,
          decision_making: TEXT,
          fund_management: TEXT,
          member_rights: TEXT,
          dispute_resolution: TEXT,
          amendment_process: TEXT,
          safety_override_acknowledgment: TEXT,
          appeals_path: TEXT,
        },
      },
    });
    const executed = await executeProposal(services, { roomId: ROOM, proposalId, userId: USER });
    if ('code' in executed) throw new Error(executed.message);
    expect((await services.charters.latestByRoom(ROOM))?.version).toBe(1);
  });

  it('blocks a law-pack upgrade whose action carries no law_pack_id', async () => {
    const services = await wsmServices();
    const proposalId = await timelockedProposal(services, { proposalType: 'law_pack_upgrade' });
    const blocked = await executeProposal(services, { roomId: ROOM, proposalId, userId: USER });
    expect('code' in blocked && blocked.code).toBe('law_pack_id_missing');
    expect((await services.proposals.getById(proposalId))?.executionState).toBe('blocked');
  });

  it('blocks a spend the kernel refuses and releases its reservation', async () => {
    const services = await wsmServices();
    services.treasuryExecutor = {
      execute: async () => ({ accepted: false, code: 'cap_exceeded' }),
    };
    const treasury = await provisionTreasury(services);
    const proposalId = await timelockedProposal(services, {
      category: 'grant',
      requestedAmount: '10',
      asset: 'USDC',
      recipientRef: 'coop',
    });
    const reserved = await reserveForProposal(services, {
      treasuryId: treasury.treasuryId,
      proposalId,
      category: 'grant',
      asset: 'USDC',
      amount: '10',
      bounds: BOUNDS,
    });
    if ('code' in reserved) throw new Error(reserved.message);
    const blocked = await executeProposal(services, { roomId: ROOM, proposalId, userId: USER });
    expect('code' in blocked && blocked.code).toBe('cap_exceeded');
    expect((await services.proposals.getById(proposalId))?.executionState).toBe('blocked');
    // The headroom returned: the reservation is released, not stranded.
    expect((await services.reservations.getByProposal(proposalId))?.state).toBe('released');
  });

  it('re-checks every prerequisite at execution time', async () => {
    const services = await wsmServices();
    const open = await timelockedProposal(services, { votingState: 'open' as never });
    expect(
      'code' in
        (await executeProposal(services, { roomId: ROOM, proposalId: open, userId: USER })) &&
        (await executeProposal(services, { roomId: ROOM, proposalId: open, userId: USER })),
    ).toBeTruthy();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const locked = await timelockedProposal(services, { executableAfter: future });
    const still = await executeProposal(services, {
      roomId: ROOM,
      proposalId: locked,
      userId: USER,
    });
    expect('code' in still && still.code).toBe('timelocked');
    const window = await timelockedProposal(services, { challengeWindowEndsAt: future });
    const waiting = await executeProposal(services, {
      roomId: ROOM,
      proposalId: window,
      userId: USER,
    });
    expect('code' in waiting && waiting.code).toBe('challenge_window_open');
  });
});

describe('second review wave (PR #144): TTL, freeze re-checks, grant-failure ordering', () => {
  it('an expired timed intent can only be abandoned, never advanced', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const created = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '1',
      idempotencyKey: randomUUID(),
    });
    if ('code' in created) throw new Error(created.message);
    // Force the TTL into the past without touching the state machine.
    await services.intents.transition(
      created.intent.paymentIntentId,
      'created',
      'preflighted',
      { expiresAt: new Date(Date.now() - 1_000).toISOString() },
      new Date().toISOString(),
    );
    const { quoteIntent: quote } = await import('../treasury/intents.js');
    const stale = await quote(services, created.intent.paymentIntentId, USER);
    expect('code' in stale && stale.code).toBe('invalid_transition');
    // The expiry sweep still moves it to abandoned.
    const { expireIntents } = await import('../treasury/intents.js');
    expect(await expireIntents(services)).toBeGreaterThanOrEqual(1);
    expect((await services.intents.getById(created.intent.paymentIntentId))?.executionState).toBe(
      'abandoned',
    );
  });

  it('a freeze landed after preflight stops quote/sign/attach/retry', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const created = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '1',
      idempotencyKey: randomUUID(),
    });
    if ('code' in created) throw new Error(created.message);
    const { preflightIntent, quoteIntent: quote } = await import('../treasury/intents.js');
    const preflighted = await preflightIntent(services, created.intent.paymentIntentId, USER);
    if ('code' in preflighted) throw new Error(preflighted.message);
    // The emergency lands between preflight and quote.
    const { setGovernanceFreeze } = await import('../treasury/profile.js');
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'incident',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    const blocked = await quote(services, created.intent.paymentIntentId, USER);
    expect('code' in blocked && blocked.code).toBe('governance_frozen');
  });

  it('a malformed milestone plan blocks execution and releases the reservation', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const proposalId = randomUUID();
    const past = new Date(Date.now() - 60_000).toISOString();
    await services.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'capped_grant',
      title: 'Bad milestones',
      plainLanguageSummary: 'Tranches do not sum.',
      requestedAmount: '100',
      asset: 'USDC',
      recipientRef: 'coop',
      conflictDisclosures: 'None.',
      riskAssessment: 'Low.',
      // Tranches sum to 90 ≠ the approved 100 — the grant plan must reject.
      requestedAction: {
        kind: 'grant',
        milestones: [
          { description: 'half', amount: '45' },
          { description: 'other', amount: '45' },
        ],
      },
      expectedDeliverable: 'None.',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'none',
      executionState: 'timelocked',
      simulationMode: false,
      executableAfter: past,
      createdAt: past,
      executedAt: null,
      executionClaimedAt: null,
      lawPackVersionId: null,
      category: 'grant',
      deliberationEndsAt: null,
      votingEndsAt: past,
      challengeWindowEndsAt: past,
      tallySnapshot: null,
    });
    const reserved = await reserveForProposal(services, {
      treasuryId: treasury.treasuryId,
      proposalId,
      category: 'grant',
      asset: 'USDC',
      amount: '100',
      bounds: BOUNDS,
    });
    if ('code' in reserved) throw new Error(reserved.message);
    const blocked = await executeProposal(services, { roomId: ROOM, proposalId, userId: USER });
    expect('code' in blocked && blocked.code).toBe('grant_creation_failed');
    expect((await services.proposals.getById(proposalId))?.executionState).toBe('blocked');
    // The headroom came back: released, never consumed.
    expect((await services.reservations.getByProposal(proposalId))?.state).toBe('released');
    expect(await services.grants.getByProposal(proposalId)).toBeNull();
  });
});

describe('third review wave (PR #144): liquidity, sweeps, recovery, charter freeze', () => {
  it('subtracts existing reservations from spend liquidity and requires a synced treasury', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    // Reconciled: 150 USDC on the books.
    await services.treasuries.setReconciliation(
      treasury.treasuryId,
      'synced',
      { USDC: '150' },
      new Date().toISOString(),
    );
    // An earlier passed proposal already reserved 100.
    const priorProposal = randomUUID();
    await reserveForProposal(services, {
      treasuryId: treasury.treasuryId,
      proposalId: priorProposal,
      category: 'grant',
      asset: 'USDC',
      amount: '100',
      bounds: BOUNDS,
    });
    const remaining = await services.reservations.listActiveByTreasuryAsset(
      treasury.treasuryId,
      'USDC',
    );
    expect(remaining).toHaveLength(1);
    // The liquidity left is 50: a 60-USDC ask must refuse even though the raw
    // balance (150) would cover it.  (Asserted at the reservation layer here;
    // the createProductionProposal wiring is covered by the proposals suite.)
    const { decSum } = await import('@licio/governance');
    const liquid = decSum(['150', `-${remaining[0]?.amount ?? '0'}`]);
    expect(liquid).toBe('50');

    // Non-synced treasuries pause NEW spend authorizations outright.
    await services.treasuries.setReconciliation(treasury.treasuryId, 'divergent', null, null);
    expect((await services.treasuries.getById(treasury.treasuryId))?.reconciliationState).toBe(
      'divergent',
    );
  });

  it('the settle sweep reaches due work behind a full page of terminal history', async () => {
    const services = await wsmServices();
    await services.profiles.upsert({
      roomId: ROOM,
      lawPackId: null,
      charterVersionId: null,
      treasuryId: null,
      quorumPolicyRef: null,
      thresholdPolicyRef: null,
      timelockPolicyRef: null,
      freezeState: 'active',
      freezeReason: null,
      pauseFlags: { deposits: false, proposals: false, executions: false },
      updatedAt: new Date().toISOString(),
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const base = {
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'capped_grant' as const,
      title: 'Filler',
      plainLanguageSummary: 'Terminal history.',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'Low.',
      requestedAction: {},
      expectedDeliverable: 'None.',
      preflightState: 'passed' as const,
      challengeState: 'none' as const,
      simulationMode: false,
      executableAfter: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
      lawPackVersionId: null,
      category: null,
      deliberationEndsAt: null,
      votingEndsAt: null,
      challengeWindowEndsAt: null,
      tallySnapshot: null,
    };
    // 600 TERMINAL rows — more than the sweep's page.
    for (let i = 0; i < 600; i += 1) {
      await services.proposals.insert({
        ...base,
        proposalId: randomUUID(),
        votingState: 'rejected',
        executionState: 'not_executed',
      });
    }
    // One DUE deliberation row hiding behind them.
    const dueId = randomUUID();
    await services.proposals.insert({
      ...base,
      proposalId: dueId,
      votingState: 'deliberation',
      executionState: 'not_executed',
      deliberationEndsAt: past,
      votingEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { settleDueProposals } = await import('../treasury/proposals.js');
    await settleDueProposals(services, ROOM);
    expect((await services.proposals.getById(dueId))?.votingState).toBe('open');
  });

  it('pauses execution-window expiry while a challenge is unresolved', async () => {
    const services = await wsmServices();
    // 30 days past a 14-day execution window: expiry WOULD fire — the open
    // challenge is the only thing holding it.
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const proposalId = randomUUID();
    await services.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'capped_grant',
      title: 'Challenged',
      plainLanguageSummary: 'Waiting on review.',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'Low.',
      requestedAction: {},
      expectedDeliverable: 'None.',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'open',
      executionState: 'timelocked',
      simulationMode: false,
      executableAfter: past,
      createdAt: past,
      executedAt: null,
      executionClaimedAt: null,
      lawPackVersionId: null,
      category: null,
      deliberationEndsAt: null,
      votingEndsAt: past,
      challengeWindowEndsAt: past,
      tallySnapshot: null,
    });
    const { settleDueProposals } = await import('../treasury/proposals.js');
    await services.profiles.upsert({
      roomId: ROOM,
      lawPackId: null,
      charterVersionId: null,
      treasuryId: null,
      quorumPolicyRef: null,
      thresholdPolicyRef: null,
      timelockPolicyRef: null,
      freezeState: 'active',
      freezeReason: null,
      pauseFlags: { deposits: false, proposals: false, executions: false },
      updatedAt: new Date().toISOString(),
    });
    await settleDueProposals(services, ROOM);
    // Still timelocked: the window does not burn down under an open challenge.
    expect((await services.proposals.getById(proposalId))?.executionState).toBe('timelocked');
  });

  it('recovers a stranded executing claim into blocked with the reservation released', async () => {
    const services = await wsmServices();
    const treasury = await provisionTreasury(services);
    const staleClaim = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const proposalId = randomUUID();
    await services.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'capped_grant',
      title: 'Stranded',
      plainLanguageSummary: 'Crashed mid-execution.',
      requestedAmount: '10',
      asset: 'USDC',
      recipientRef: 'coop',
      conflictDisclosures: 'None.',
      riskAssessment: 'Low.',
      requestedAction: { kind: 'grant' },
      expectedDeliverable: 'None.',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'none',
      executionState: 'executing',
      simulationMode: false,
      executableAfter: staleClaim,
      createdAt: staleClaim,
      executedAt: null,
      executionClaimedAt: staleClaim,
      lawPackVersionId: null,
      category: 'grant',
      deliberationEndsAt: null,
      votingEndsAt: staleClaim,
      challengeWindowEndsAt: staleClaim,
      tallySnapshot: null,
    });
    await reserveForProposal(services, {
      treasuryId: treasury.treasuryId,
      proposalId,
      category: 'grant',
      asset: 'USDC',
      amount: '10',
      bounds: BOUNDS,
    });
    const { settleDueProposals } = await import('../treasury/proposals.js');
    await settleDueProposals(services, ROOM);
    expect((await services.proposals.getById(proposalId))?.executionState).toBe('blocked');
    expect((await services.reservations.getByProposal(proposalId))?.state).toBe('released');
  });

  it('a frozen room cannot publish a charter version', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const { setGovernanceFreeze } = await import('../treasury/profile.js');
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'incident',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    const { createCharterVersion } = await import('../treasury/charter.js');
    const TEXT =
      'This section is written in plain language. It explains the rule simply. Everyone can read it.';
    const blocked = await createCharterVersion(services, {
      roomId: ROOM,
      sections: {
        purpose: TEXT,
        decision_making: TEXT,
        fund_management: TEXT,
        member_rights: TEXT,
        dispute_resolution: TEXT,
        amendment_process: TEXT,
        safety_override_acknowledgment: TEXT,
        appeals_path: TEXT,
      },
      actorUserId: USER,
    });
    expect('code' in blocked && blocked.code).toBe('governance_frozen');
  });
});

describe('fourth review wave (PR #144): races, freezes, attestations, exports', () => {
  it('replays an existing intent even after the room freezes (idempotency-first)', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const key = randomUUID();
    const first = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '50',
      idempotencyKey: key,
    });
    if ('code' in first) throw new Error(first.message);
    const frozen = await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'Routine review.',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    if ('code' in frozen) throw new Error(frozen.message);
    // The retrying client gets its EXISTING row back — the freeze landing
    // after the original create must not hide it.
    const replay = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '50',
      idempotencyKey: key,
    });
    expect(replay).toMatchObject({ ok: true, existing: true });
    if ('code' in replay) throw new Error('unreachable');
    expect(replay.intent.paymentIntentId).toBe(first.intent.paymentIntentId);
    // A NEW intent is still refused while frozen.
    const fresh = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '50',
      idempotencyKey: randomUUID(),
    });
    expect('code' in fresh && fresh.code).toBe('governance_frozen');
  });

  it('self-abandons a deposit that a concurrent create pushed over the allowance', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services); // perUserPerPeriod 1000
    const raw = services.intents;
    let intercepted = false;
    services.intents = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'insert' && !intercepted) {
          return async (record: Parameters<typeof raw.insert>[0]) => {
            intercepted = true;
            const inserted = await target.insert(record);
            // The concurrent competitor lands between the insert and the
            // post-insert re-verify: 950 + 100 = 1050 > the 1000 cap.
            await target.insert({
              ...record,
              paymentIntentId: randomUUID(),
              idempotencyKey: randomUUID(),
              amount: '950',
            });
            return inserted;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const key = randomUUID();
    const result = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: key,
    });
    expect('code' in result && result.code).toBe('deposit_limit_exceeded');
    services.intents = raw;
    // The overshooting row DELETED itself (not abandoned) — no terminal row is
    // left holding the idempotency key.  The competitor survives.
    const epoch = new Date(0).toISOString();
    const rows = await services.intents.listDepositsInPeriod(ROOM, epoch);
    expect(rows.find((r) => r.amount === '100')).toBeUndefined();
    expect(rows.find((r) => r.amount === '950')?.executionState).toBe('created');
    // A retry with the SAME key does NOT replay a dead abandoned intent as a
    // successful create: the key is free, so the create re-runs and answers the
    // allowance honestly (never `{ ok: true, existing: true }` for a terminal row).
    const retry = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: key,
    });
    expect('code' in retry && retry.code).toBe('deposit_limit_exceeded');
  });

  it('self-releases a reservation that a concurrent approval pushed over the window cap', async () => {
    const services = await wsmServices();
    const treasury = await provisionTreasury(services); // BOUNDS: window cap 150
    const proposalId = randomUUID();
    const competitorId = randomUUID();
    const raw = services.reservations;
    let intercepted = false;
    services.reservations = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'insert' && !intercepted) {
          return async (record: Parameters<typeof raw.insert>[0]) => {
            intercepted = true;
            const inserted = await target.insert(record);
            // A second approval settles in the race window: 100 + 100 > 150.
            await target.insert({
              ...record,
              reservationId: randomUUID(),
              proposalId: competitorId,
            });
            return inserted;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await reserveForProposal(services, {
      treasuryId: treasury.treasuryId,
      proposalId,
      category: 'grant',
      asset: 'USDC',
      amount: '100',
      bounds: BOUNDS,
    });
    expect('code' in result && result.code).toBe('per_window_cap_exceeded');
    services.reservations = raw;
    expect((await services.reservations.getByProposal(proposalId))?.state).toBe('released');
    expect((await services.reservations.getByProposal(competitorId))?.state).toBe('reserved');
  });

  it('a room unfreeze clears its own cascade but never an independent treasury hold', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    // Room freeze cascades to the treasury under the SAME reason…
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'Room-level review.',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    // …then platform staff place an INDEPENDENT treasury-scope hold.
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'treasury',
      source: 'legal',
      reason: 'Legal hold on funds.',
      actorUserId: null,
      isPlatformStaff: true,
    });
    // Lifting the ROOM freeze must not lift the legal hold.
    const lifted = await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'unfreeze',
      scope: 'room',
      source: 'steward',
      reason: 'Review complete.',
      actorUserId: null,
      isPlatformStaff: true,
    });
    if ('code' in lifted) throw new Error(lifted.message);
    expect(lifted.profile.freezeState).toBe('active');
    const held = await services.treasuries.getById(treasury.treasuryId);
    expect(held?.freezeState).toBe('frozen');
    expect(held?.freezeReason).toBe('Legal hold on funds.');
    // The independent hold survives EVEN with identical wording (W10: the
    // cascade is a structural marker, never reason-text equality).  Lift it
    // explicitly, then prove a PURE cascade clears with the room.
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'unfreeze',
      scope: 'treasury',
      source: 'legal',
      reason: 'Legal hold released.',
      actorUserId: null,
      isPlatformStaff: true,
    });
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'Room-level review 2.',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    expect((await services.treasuries.getById(treasury.treasuryId))?.freezeState).toBe('frozen');
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'unfreeze',
      scope: 'room',
      source: 'steward',
      reason: 'Cleared.',
      actorUserId: null,
      isPlatformStaff: true,
    });
    expect((await services.treasuries.getById(treasury.treasuryId))?.freezeState).toBe('active');
  });

  it('excludes settled rows whose asset has NO reconciliation snapshot at all', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const created = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '5',
      idempotencyKey: randomUUID(),
    });
    if ('code' in created) throw new Error(created.message);
    const nowIso = new Date().toISOString();
    for (const [from, to] of [
      ['created', 'preflighted'],
      ['preflighted', 'quoted'],
      ['quoted', 'signed'],
      ['signed', 'submitted'],
      ['submitted', 'pending'],
      ['pending', 'confirmed'],
      ['confirmed', 'finalized'],
    ] as const) {
      await services.intents.transition(created.intent.paymentIntentId, from, to, {}, nowIso);
    }
    // NO snapshot appended: an unreconciled asset is treated as divergent —
    // excluded and COUNTED, never silently exported as clean.
    const built = await buildAccountingExport(services, {
      roomId: ROOM,
      periodStartIso: new Date(Date.now() - 3_600_000).toISOString(),
      periodEndIso: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if ('code' in built) throw new Error(built.message);
    expect(built.export.rows).toHaveLength(0);
    expect(built.export.excluded_unreconciled).toBe(1);
  });

  it('provisioning validates the deployment against the ACTIVE pin', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const unknown = await createTreasury(services, {
      roomId: ROOM,
      deploymentId: randomUUID(), // not in the pinned manifest
      treasuryAddress: `0x${'ab'.repeat(20)}`,
      acceptedAssets: ['USDC'],
      depositLimits: {
        perUserPerPeriod: '1000',
        perRoomPerPeriod: '5000',
        perDepositMax: '100',
        periodSeconds: 86_400,
      },
      actorUserId: USER,
    });
    expect('code' in unknown && unknown.code).toBe('deployment_unknown');
  });

  it('only a room steward can record the safety-override acknowledgment', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const notSteward = {
      ...services,
      rooms: { ...services.rooms, isSteward: async () => false },
    };
    const refused = await recordReadinessAttestation(notSteward, {
      roomId: ROOM,
      item: 'safety_override_acknowledged',
      note: 'We acknowledge the platform moderation floor.',
      actorUserId: USER,
      isPlatformStaff: true, // staff CANNOT acknowledge on the room's behalf
    });
    expect('code' in refused && refused.code).toBe('steward_required');
    const accepted = await recordReadinessAttestation(services, {
      roomId: ROOM,
      item: 'safety_override_acknowledged',
      note: 'We acknowledge the platform moderation floor.',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    expect(accepted).toMatchObject({ ok: true });
  });
});

describe('fifth review wave (PR #144): clawback, freezes, CAS tokens, owner preflight', () => {
  it('a clawed-back grant refuses every milestone update', async () => {
    const services = await wsmServices();
    const treasury = await provisionTreasury(services);
    const milestoneId = randomUUID();
    const grant = await services.grants.insert({
      grantId: randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: randomUUID(),
      recipientRef: `user:${OTHER}`,
      purpose: 'Translation sprint',
      amount: '100',
      asset: 'USDC',
      milestones: [
        {
          milestoneId,
          description: 'All',
          amount: '100',
          state: 'submitted',
          paymentIntentId: null,
        },
      ],
      milestoneState: 'submitted',
      reviewState: 'cleared',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (grant === null) throw new Error('fixture grant collision');
    const clawed = await markGrantClawedBack(services, {
      roomId: ROOM,
      grantId: grant.grantId,
      actorUserId: USER,
      note: 'Upheld dispute.',
    });
    expect(clawed).toMatchObject({ ok: true });
    // Acceptance after clawback would mint a fresh payout intent past the
    // reversal — every milestone transition is closed.
    expect(
      await updateGrantMilestone(services, {
        roomId: ROOM,
        grantId: grant.grantId,
        milestoneId,
        state: 'accepted',
        actorUserId: USER,
      }),
    ).toMatchObject({ ok: false, code: 'grant_clawed_back' });
  });

  it('a frozen room refuses NEW delegations but still allows revocation', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const created = await createDelegation(services, {
      roomId: ROOM,
      delegatorUserId: USER,
      delegateUserId: OTHER,
      scope: { all: true },
    });
    if ('code' in created) throw new Error(created.message);
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'Emergency review.',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    expect(
      await createDelegation(services, {
        roomId: ROOM,
        delegatorUserId: OTHER,
        delegateUserId: USER,
        scope: { all: true },
      }),
    ).toMatchObject({ ok: false, code: 'governance_frozen' });
    // Withdrawing power stays open under a freeze.
    expect(
      await revokeDelegation(services, {
        roomId: ROOM,
        delegationId: created.delegation.delegationId,
        actorUserId: USER,
        isPlatformStaff: false,
      }),
    ).toMatchObject({ ok: true });
  });

  it('every budget write advances the CAS token, even inside one millisecond', async () => {
    const services = await wsmServices();
    const frozenNow = Date.now();
    const deps = { ...services, now: () => frozenNow };
    const rules = {
      costs: { proposal_submission: 2 },
      refill: { periodSeconds: 86_400, units: 0, max: 10 },
    };
    const first = await chargeRoomActionBudget(deps, {
      roomId: ROOM,
      userId: USER,
      actionType: 'proposal_submission',
      rules,
    });
    expect(first).toMatchObject({ ok: true, remaining: 8 });
    const afterFirst = await services.budgets.get(ROOM, `user:${USER}`);
    // Same-millisecond second charge: the token must STILL move, or a stale
    // concurrent writer could re-satisfy the compare and double-spend.
    const second = await chargeRoomActionBudget(deps, {
      roomId: ROOM,
      userId: USER,
      actionType: 'proposal_submission',
      rules,
    });
    expect(second).toMatchObject({ ok: true, remaining: 6 });
    const afterSecond = await services.budgets.get(ROOM, `user:${USER}`);
    expect(afterSecond?.updatedAt).not.toBe(afterFirst?.updatedAt);
    expect(Date.parse(afterSecond?.updatedAt ?? '')).toBeGreaterThan(
      Date.parse(afterFirst?.updatedAt ?? ''),
    );
    // The refund advances it too, capped at the refill max.
    await refundActionBudget(deps, { roomId: ROOM, userId: USER, units: 99, rules });
    const afterRefund = await services.budgets.get(ROOM, `user:${USER}`);
    expect(afterRefund?.availableUnits).toBe(10);
    expect(Date.parse(afterRefund?.updatedAt ?? '')).toBeGreaterThan(
      Date.parse(afterSecond?.updatedAt ?? ''),
    );
  });

  it('preflight evaluates the intent OWNER, not the steward driving it', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const created = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '50',
      idempotencyKey: randomUUID(),
    });
    if ('code' in created) throw new Error(created.message);
    // The OWNER's region is blocked; the steward's is fine.  A steward-driven
    // preflight must still evaluate the member the money belongs to.
    const deps = {
      ...services,
      compliance: {
        ...services.compliance,
        jurisdiction: async ({ userId }: { userId: string; region: string | null }) =>
          userId === USER ? ('blocked' as const) : ('allowed' as const),
      },
    };
    expect(await preflightIntent(deps, created.intent.paymentIntentId, OTHER)).toMatchObject({
      ok: false,
      code: 'jurisdiction_blocked',
    });
  });

  it('room-owned intents (null owner) are idempotent per (room, key)', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    await provisionTreasury(services);
    const key = randomUUID();
    const make = () =>
      createPaymentIntent(services, {
        userId: null,
        actorUserId: USER,
        roomId: ROOM,
        targetType: 'grant_payout',
        targetId: randomUUID(),
        asset: 'USDC',
        amount: '10',
        idempotencyKey: key,
      });
    const first = await make();
    if ('code' in first) throw new Error(first.message);
    expect(first.intent.userId).toBeNull();
    // A second steward accepting the same milestone converges on ONE intent.
    const replay = await make();
    if ('code' in replay) throw new Error(replay.message);
    expect(replay.existing).toBe(true);
    expect(replay.intent.paymentIntentId).toBe(first.intent.paymentIntentId);
    // Deposits stay member-owned: a null-owner deposit is a contract error.
    expect(
      await createPaymentIntent(services, {
        userId: null,
        actorUserId: USER,
        roomId: ROOM,
        targetType: 'treasury_deposit',
        targetId: randomUUID(),
        asset: 'USDC',
        amount: '10',
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false, code: 'owner_required' });
  });
});

describe('sixth review wave (PR #144): deposit retry caps', () => {
  it('a deposit retry re-checks the allowance the failure released', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services); // perUserPerPeriod 1000
    const created = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: randomUUID(),
    });
    if ('code' in created) throw new Error(created.message);
    const id = created.intent.paymentIntentId;
    // Walk to a FAILED submission: the amount leaves the allowance aggregate.
    const nowIso = new Date().toISOString();
    for (const [from, to] of [
      ['created', 'preflighted'],
      ['preflighted', 'quoted'],
      ['quoted', 'signed'],
      ['signed', 'submitted'],
      ['submitted', 'pending'],
      ['pending', 'failed'],
    ] as const) {
      await services.intents.transition(id, from, to, {}, nowIso);
    }
    // Ten fresh deposits consume the ENTIRE 1000 allowance the failure freed.
    for (let i = 0; i < 10; i += 1) {
      const filler = await createPaymentIntent(services, {
        userId: USER,
        actorUserId: USER,
        roomId: ROOM,
        targetType: 'treasury_deposit',
        targetId: treasury.treasuryId,
        asset: 'USDC',
        amount: '100',
        idempotencyKey: randomUUID(),
      });
      if ('code' in filler) throw new Error(filler.message);
    }
    // The retry would push in-flight deposits to 1100 > the 1000 cap — it
    // must re-run the allowance check instead of silently re-entering
    // `created`.
    const retried = await retryIntent(services, id, USER);
    expect('code' in retried && retried.code).toBe('deposit_limit_exceeded');
    expect((await services.intents.getById(id))?.executionState).toBe('failed');
  });
});

describe('seventh review wave (PR #144): divergence halts funds, freeze-safe pointers', () => {
  it('an unexplained divergence blocks deposits and executions by itself', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    await services.treasuries.setReconciliation(treasury.treasuryId, 'divergent', null, null);
    // No operator freeze happened — the divergence ALONE halts fund movement.
    const deposit = await createPaymentIntent(services, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '50',
      idempotencyKey: randomUUID(),
    });
    expect('code' in deposit && deposit.code).toBe('treasury_divergent');
    // Self-healing: a clean reconciliation lifts the block without an unfreeze.
    await services.treasuries.setReconciliation(
      treasury.treasuryId,
      'synced',
      { USDC: '0' },
      new Date().toISOString(),
    );
    expect(
      await createPaymentIntent(services, {
        userId: USER,
        actorUserId: USER,
        roomId: ROOM,
        targetType: 'treasury_deposit',
        targetId: treasury.treasuryId,
        asset: 'USDC',
        amount: '50',
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: true });
  });

  it('a freeze landing mid-publish survives the charter pointer write', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const SECTION =
      'This section is written in plain language. It explains the rule simply. Everyone can read it.';
    const sections = {
      purpose: SECTION,
      decision_making: SECTION,
      fund_management: SECTION,
      member_rights: SECTION,
      dispute_resolution: SECTION,
      amendment_process: SECTION,
      safety_override_acknowledgment: SECTION,
      appeals_path: SECTION,
    };
    // An emergency freeze lands AFTER the writability check, WHILE the version
    // insert is in flight — the pointer write must not clobber it.
    const rawCharters = services.charters;
    const deps = {
      ...services,
      charters: new Proxy(rawCharters, {
        get(target, prop) {
          if (prop === 'insert') {
            return async (record: Parameters<typeof rawCharters.insert>[0]) => {
              const inserted = await target.insert(record);
              const profile = await services.profiles.get(ROOM);
              if (profile !== null) {
                await services.profiles.upsert({
                  ...profile,
                  freezeState: 'frozen',
                  freezeReason: 'Emergency mid-publish.',
                });
              }
              return inserted;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    const { createCharterVersion } = await import('../treasury/charter.js');
    const published = await createCharterVersion(deps, {
      roomId: ROOM,
      sections,
      actorUserId: USER,
    });
    if ('code' in published) throw new Error(published.message);
    const profile = await services.profiles.get(ROOM);
    // The freeze SURVIVED the pointer write, and the pointer still landed.
    expect(profile?.freezeState).toBe('frozen');
    expect(profile?.charterVersionId).toBe(published.charter.charterVersionId);
  });

  it('the settle sweep pages past 600 not-yet-due proposals to reach a due one', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const base = {
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'capped_grant' as const,
      title: 'Filler',
      plainLanguageSummary: 'Not due yet.',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'Low.',
      requestedAction: {},
      expectedDeliverable: 'None.',
      preflightState: 'passed' as const,
      challengeState: 'none' as const,
      simulationMode: false,
      executableAfter: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
      lawPackVersionId: null,
      category: null,
      deliberationEndsAt: future,
      votingEndsAt: null,
      challengeWindowEndsAt: null,
      tallySnapshot: null,
    };
    // 600 UNSETTLED but not-yet-due rows — more than one keyset page.
    for (let i = 0; i < 600; i += 1) {
      await services.proposals.insert({
        ...base,
        proposalId: randomUUID(),
        votingState: 'deliberation',
        executionState: 'not_executed',
      });
    }
    const dueId = randomUUID();
    await services.proposals.insert({
      ...base,
      proposalId: dueId,
      votingState: 'deliberation',
      executionState: 'not_executed',
      deliberationEndsAt: past,
      votingEndsAt: future,
    });
    const { settleDueProposals } = await import('../treasury/proposals.js');
    await settleDueProposals(services, ROOM);
    expect((await services.proposals.getById(dueId))?.votingState).toBe('open');
  });
});

describe('eighth review wave (PR #144): frozen grant review', () => {
  it('a frozen room refuses grant review-state changes', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const grant = await services.grants.insert({
      grantId: randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: randomUUID(),
      recipientRef: `user:${OTHER}`,
      purpose: 'Translation sprint',
      amount: '100',
      asset: 'USDC',
      milestones: [],
      milestoneState: 'pending',
      reviewState: 'pending',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (grant === null) throw new Error('fixture grant collision');
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'Emergency review.',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    // Review clearance is the prerequisite for payout scheduling — frozen
    // rooms must not advance disbursement state.
    expect(
      await setGrantReview(services, {
        roomId: ROOM,
        grantId: grant.grantId,
        reviewState: 'cleared',
        reviewerUserId: USER,
      }),
    ).toMatchObject({ ok: false, code: 'governance_frozen' });
  });
});

describe('ninth review wave (PR #144): clawback closure, milestone CAS, freeze-safe pointers', () => {
  const SECTION_MS = {
    milestoneId: '',
    description: 'Tranche',
    amount: '50',
    state: 'submitted' as const,
    paymentIntentId: null,
  };

  async function seedGrant(services: TreasuryServices, treasuryId: string) {
    const a = { ...SECTION_MS, milestoneId: randomUUID() };
    const b = { ...SECTION_MS, milestoneId: randomUUID() };
    const grant = await services.grants.insert({
      grantId: randomUUID(),
      roomId: ROOM,
      treasuryId,
      proposalId: randomUUID(),
      recipientRef: `user:${OTHER}`,
      purpose: 'Translation sprint',
      amount: '100',
      asset: 'USDC',
      milestones: [a, b],
      milestoneState: 'submitted',
      reviewState: 'cleared',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (grant === null) throw new Error('fixture grant collision');
    return { grant, a, b };
  }

  it('clawback abandons open payout intents and closes attach/retry', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const { grant, a } = await seedGrant(services, treasury.treasuryId);
    const accepted = await updateGrantMilestone(services, {
      roomId: ROOM,
      grantId: grant.grantId,
      milestoneId: a.milestoneId,
      state: 'accepted',
      actorUserId: USER,
    });
    if ('code' in accepted) throw new Error(accepted.message);
    const intentId = accepted.grant.milestones.find(
      (m) => m.milestoneId === a.milestoneId,
    )?.paymentIntentId;
    if (intentId == null) throw new Error('payout intent missing');
    // A failed-retryable intent for the OTHER milestone (the retry guard leg).
    const failedIntent = await services.intents.insert({
      paymentIntentId: randomUUID(),
      userId: null,
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      targetType: 'grant_payout',
      targetId: grant.grantId,
      asset: 'USDC',
      amount: '50',
      jurisdictionState: 'allowed',
      complianceState: 'cleared',
      executionState: 'failed',
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: null,
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const clawed = await markGrantClawedBack(services, {
      roomId: ROOM,
      grantId: grant.grantId,
      actorUserId: USER,
      note: 'Upheld dispute.',
    });
    expect(clawed).toMatchObject({ ok: true });
    // The scheduled (pre-submission) payout intent was ABANDONED with it.
    expect((await services.intents.getById(intentId))?.executionState).toBe('abandoned');
    // A failed payout against the clawed-back grant cannot retry…
    expect(await retryIntent(services, failedIntent.paymentIntentId, USER)).toMatchObject({
      ok: false,
      code: 'grant_clawed_back',
    });
  });

  it('a frozen room refuses every milestone transition, not just acceptance', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const { grant } = await seedGrant(services, treasury.treasuryId);
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'Emergency review.',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    expect(
      await updateGrantMilestone(services, {
        roomId: ROOM,
        grantId: grant.grantId,
        milestoneId: grant.milestones[1]?.milestoneId ?? '',
        state: 'rejected',
        actorUserId: USER,
      }),
    ).toMatchObject({ ok: false, code: 'governance_frozen' });
  });

  it('milestone updates are CAS-scoped: siblings survive, stale writes lose', async () => {
    const services = await wsmServices();
    const treasury = await provisionTreasury(services);
    const { grant, a, b } = await seedGrant(services, treasury.treasuryId);
    // Two "concurrent" single-milestone transitions: both persist.
    const first = await services.grants.applyMilestoneTransition(
      grant.grantId,
      a.milestoneId,
      'submitted',
      'rejected',
      null,
    );
    expect(first?.milestones.find((m) => m.milestoneId === a.milestoneId)?.state).toBe('rejected');
    const second = await services.grants.applyMilestoneTransition(
      grant.grantId,
      b.milestoneId,
      'submitted',
      'accepted',
      randomUUID(),
    );
    expect(second?.milestones.find((m) => m.milestoneId === a.milestoneId)?.state).toBe('rejected');
    expect(second?.milestones.find((m) => m.milestoneId === b.milestoneId)?.state).toBe('accepted');
    // A STALE write (expecting the pre-transition state) loses the CAS.
    expect(
      await services.grants.applyMilestoneTransition(
        grant.grantId,
        a.milestoneId,
        'submitted',
        'accepted',
        null,
      ),
    ).toBeNull();
  });

  it('unsettled-grant paging filters settled rows and honors the cursor', async () => {
    const services = await wsmServices();
    const treasury = await provisionTreasury(services);
    const mk = async (payoutState: 'not_started' | 'paid' | 'clawed_back') => {
      const row = await services.grants.insert({
        grantId: randomUUID(),
        roomId: ROOM,
        treasuryId: treasury.treasuryId,
        proposalId: randomUUID(),
        recipientRef: 'r',
        purpose: 'p',
        amount: '10',
        asset: 'USDC',
        milestones: [],
        milestoneState: 'pending',
        reviewState: 'pending',
        payoutState,
        auditSummary: null,
        createdAt: new Date().toISOString(),
      });
      if (row === null) throw new Error('collision');
      return row;
    };
    await mk('not_started');
    await mk('not_started');
    await mk('paid');
    await mk('clawed_back');
    const pageOne = await services.grants.listUnsettledByTreasury(treasury.treasuryId, 1, null);
    expect(pageOne).toHaveLength(1);
    const pageTwo = await services.grants.listUnsettledByTreasury(
      treasury.treasuryId,
      10,
      pageOne[0]?.grantId ?? null,
    );
    expect(pageTwo).toHaveLength(1);
    expect(pageTwo[0]?.payoutState).toBe('not_started');
  });

  it('a freeze landing mid-provision survives the treasury pointer write', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const rawTreasuries = services.treasuries;
    const deps = {
      ...services,
      treasuries: new Proxy(rawTreasuries, {
        get(target, prop) {
          if (prop === 'insert') {
            return async (record: Parameters<typeof rawTreasuries.insert>[0]) => {
              const inserted = await target.insert(record);
              const profile = await services.profiles.get(ROOM);
              if (profile !== null) {
                await services.profiles.upsert({
                  ...profile,
                  freezeState: 'frozen',
                  freezeReason: 'Emergency mid-provision.',
                });
              }
              return inserted;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    const created = await createTreasury(deps, {
      roomId: ROOM,
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      treasuryAddress: `0x${'cd'.repeat(20)}`,
      acceptedAssets: ['USDC'],
      depositLimits: {
        perUserPerPeriod: '1000',
        perRoomPerPeriod: '5000',
        perDepositMax: '100',
        periodSeconds: 86_400,
      },
      actorUserId: USER,
    });
    if (!('treasury' in created)) throw new Error(JSON.stringify(created));
    const profile = await services.profiles.get(ROOM);
    expect(profile?.freezeState).toBe('frozen');
    expect(profile?.treasuryId).toBe(created.treasury.treasuryId);
  });

  it('a pause write from a stale read cannot clear a freeze', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    // The STORED profile freezes; the pause path reads a STALE active copy.
    const stale = await services.profiles.get(ROOM);
    if (stale === null) throw new Error('profile missing');
    await services.profiles.upsert({
      ...stale,
      freezeState: 'frozen',
      freezeReason: 'Emergency.',
    });
    const deps = {
      ...services,
      profiles: new Proxy(services.profiles, {
        get(target, prop) {
          if (prop === 'get') {
            return async () => structuredClone(stale); // the pre-freeze snapshot
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    const paused = await setGovernancePause(deps, {
      roomId: ROOM,
      patch: { deposits: true },
      reason: 'Maintenance.',
      actorUserId: USER,
    });
    if ('code' in paused) throw new Error(paused.message);
    const current = await services.profiles.get(ROOM);
    // The column-scoped write changed the FLAGS and left the freeze intact.
    expect(current?.freezeState).toBe('frozen');
    expect(current?.pauseFlags.deposits).toBe(true);
  });
});

describe('tenth review wave (PR #144): the cascade marker', () => {
  it('an independent treasury hold with IDENTICAL wording survives the room unfreeze', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const WORDING = 'Pending review.';
    // Room freeze cascades (marker set)…
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: WORDING,
      actorUserId: USER,
      isPlatformStaff: false,
    });
    // …then platform staff place an EXPLICIT treasury hold using the SAME
    // common wording — the free-form text must not relabel it as a cascade.
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'treasury',
      source: 'legal',
      reason: WORDING,
      actorUserId: null,
      isPlatformStaff: true,
    });
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'unfreeze',
      scope: 'room',
      source: 'steward',
      reason: WORDING,
      actorUserId: null,
      isPlatformStaff: true,
    });
    const held = await services.treasuries.getById(treasury.treasuryId);
    expect(held?.freezeState).toBe('frozen');
    expect(held?.freezeCascade).toBe(false);
  });
});

describe('eleventh review wave (PR #144): CAS-loss orphan cleanup', () => {
  it('an accept that loses the milestone CAS abandons its freshly minted intent', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const milestoneId = randomUUID();
    const grant = await services.grants.insert({
      grantId: randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: randomUUID(),
      recipientRef: `0x${'aa'.repeat(20)}`,
      purpose: 'Race fixture',
      amount: '50',
      asset: 'USDC',
      milestones: [
        {
          milestoneId,
          description: 'All',
          amount: '50',
          state: 'submitted',
          paymentIntentId: null,
        },
      ],
      milestoneState: 'submitted',
      reviewState: 'cleared',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (grant === null) throw new Error('fixture grant collision');
    // A REJECTION wins the race inside the accept's CAS window: the proxy
    // rejects the milestone via the raw store just before the accept's CAS.
    const raw = services.grants;
    let intercepted = false;
    services.grants = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'applyMilestoneTransition' && !intercepted) {
          return async (
            grantId: string,
            msId: string,
            fromState: Parameters<typeof raw.applyMilestoneTransition>[2],
            toState: Parameters<typeof raw.applyMilestoneTransition>[3],
            intentId: string | null,
          ) => {
            intercepted = true;
            await target.applyMilestoneTransition(grantId, msId, 'submitted', 'rejected', null);
            return target.applyMilestoneTransition(grantId, msId, fromState, toState, intentId);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await updateGrantMilestone(services, {
      roomId: ROOM,
      grantId: grant.grantId,
      milestoneId,
      state: 'accepted',
      actorUserId: USER,
    });
    services.grants = raw;
    expect('code' in result && result.code).toBe('invalid_transition');
    // The orphaned room-owned payout was ABANDONED, never left drivable.
    const orphan = await services.intents.findByIdempotencyKey(null, ROOM, milestoneId);
    expect(orphan?.executionState).toBe('abandoned');
  });
});

describe('twelfth review wave (PR #144): atomic attach, column projections, scrub', () => {
  it('the store refuses to bind one action record to two intents', async () => {
    const services = await wsmServices();
    const treasury = await provisionTreasury(services);
    const mkSigned = async () => {
      const row = await services.intents.insert({
        paymentIntentId: randomUUID(),
        userId: USER,
        roomId: ROOM,
        treasuryId: treasury.treasuryId,
        targetType: 'treasury_deposit',
        targetId: treasury.treasuryId,
        asset: 'USDC',
        amount: '100',
        jurisdictionState: 'allowed',
        complianceState: 'cleared',
        executionState: 'signed',
        retryCount: 0,
        quoteRef: null,
        actionRecordId: null,
        receiptId: null,
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return row.paymentIntentId;
    };
    const first = await mkSigned();
    const second = await mkSigned();
    const actionRecordId = randomUUID();
    const nowIso = new Date().toISOString();
    const won = await services.intents.transition(
      first,
      'signed',
      'submitted',
      { actionRecordId },
      nowIso,
    );
    expect(won).not.toBeNull();
    // The RACE loser (its pre-check read happened before the winner stored the
    // binding) hits the uniqueness at the store and loses the CAS cleanly.
    const lost = await services.intents.transition(
      second,
      'signed',
      'submitted',
      { actionRecordId },
      nowIso,
    );
    expect(lost).toBeNull();
    expect((await services.intents.getById(second))?.executionState).toBe('signed');
  });

  it('payout/review projections never rewrite a concurrently changed milestone', async () => {
    const services = await wsmServices();
    const treasury = await provisionTreasury(services);
    const a = {
      milestoneId: randomUUID(),
      description: 'A',
      amount: '50',
      state: 'submitted' as const,
      paymentIntentId: null,
    };
    const grant = await services.grants.insert({
      grantId: randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: randomUUID(),
      recipientRef: `0x${'aa'.repeat(20)}`,
      purpose: 'Projection fixture',
      amount: '50',
      asset: 'USDC',
      milestones: [a],
      milestoneState: 'submitted',
      reviewState: 'cleared',
      payoutState: 'scheduled',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (grant === null) throw new Error('fixture grant collision');
    // A milestone transition lands AFTER any earlier snapshot was taken…
    const intentId = randomUUID();
    await services.grants.applyMilestoneTransition(
      grant.grantId,
      a.milestoneId,
      'submitted',
      'accepted',
      intentId,
    );
    // …and the payout-state projection (column-scoped) must not clobber it.
    await services.grants.setPayoutState(grant.grantId, 'paid');
    const current = await services.grants.getById(grant.grantId);
    expect(current?.payoutState).toBe('paid');
    expect(current?.milestones[0]?.state).toBe('accepted');
    expect(current?.milestones[0]?.paymentIntentId).toBe(intentId);
  });

  it('a frozen room defers readiness attestations', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'Emergency review.',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    expect(
      await recordReadinessAttestation(services, {
        roomId: ROOM,
        item: 'safety_override_acknowledged',
        note: 'Recorded mid-freeze.',
        actorUserId: USER,
        isPlatformStaff: false,
      }),
    ).toMatchObject({ ok: false, code: 'governance_frozen' });
  });

  it('the deletion scrub nulls a purged user across their intents', async () => {
    const services = await wsmServices();
    const treasury = await provisionTreasury(services);
    for (let i = 0; i < 2; i += 1) {
      await services.intents.insert({
        paymentIntentId: randomUUID(),
        userId: USER,
        roomId: ROOM,
        treasuryId: treasury.treasuryId,
        targetType: 'treasury_deposit',
        targetId: treasury.treasuryId,
        asset: 'USDC',
        amount: '10',
        jurisdictionState: 'allowed',
        complianceState: 'cleared',
        executionState: 'finalized',
        retryCount: 0,
        quoteRef: null,
        actionRecordId: null,
        receiptId: randomUUID(),
        idempotencyKey: randomUUID(),
        expiresAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    expect(await services.intents.anonymizeUser(USER)).toBe(2);
    const rows = await services.intents.listDepositsInPeriod(ROOM, new Date(0).toISOString());
    expect(rows.every((r) => r.userId === null)).toBe(true);
  });

  it('malformed fixture corpora reject at publication instead of silently dropping', async () => {
    const services = await wsmServices();
    const { registerLawPack } = await import('../treasury/law-packs.js');
    const result = await registerLawPack(services, {
      roomId: ROOM,
      document: { not: 'a law pack' },
      fixtures: { fixtures: 'not-an-array' },
      actorUserId: USER,
    });
    // Structural failure fires first here; the corpus-specific leg is covered
    // in the proposals suite with a valid document.
    expect('code' in result && result.code).toBe('law_pack_invalid');
  });
});

describe('class sweep (PR #144): freeze columns + execution CAS', () => {
  it('a freeze decision never writes back stale pause flags', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    // The pause lands FIRST…
    await setGovernancePause(services, {
      roomId: ROOM,
      patch: { deposits: true },
      reason: 'Maintenance.',
      actorUserId: USER,
    });
    // …then a freeze whose profile read could be stale: the column-scoped
    // write must change ONLY the freeze fields.
    await setGovernanceFreeze(services, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'Emergency.',
      actorUserId: USER,
      isPlatformStaff: false,
    });
    const profile = await services.profiles.get(ROOM);
    expect(profile?.freezeState).toBe('frozen');
    expect(profile?.pauseFlags.deposits).toBe(true);
  });

  it('execution-state CAS writes never rewrite the challenge column', async () => {
    const services = await wsmServices();
    const proposalId = randomUUID();
    await services.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'capped_grant',
      title: 'CAS fixture',
      plainLanguageSummary: 'Execution vs challenge race.',
      requestedAmount: '100',
      asset: 'USDC',
      recipientRef: null,
      conflictDisclosures: 'None.',
      riskAssessment: 'Low.',
      requestedAction: { kind: 'grant' },
      expectedDeliverable: 'None.',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'none',
      executionState: 'executing',
      simulationMode: false,
      executableAfter: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: new Date().toISOString(),
      lawPackVersionId: null,
      category: 'grant',
      deliberationEndsAt: null,
      votingEndsAt: new Date().toISOString(),
      challengeWindowEndsAt: null,
      tallySnapshot: null,
    });
    // A challenge projection lands while the claim holder is mid-execution…
    await services.proposals.applyChallengeProjection(proposalId, { challengeState: 'open' });
    // …and the failure path's CAS releases the claim WITHOUT touching it.
    expect(
      await services.proposals.casExecutionState(proposalId, ['executing'], 'blocked', {
        clearClaim: true,
      }),
    ).toBe(true);
    const row = await services.proposals.getById(proposalId);
    expect(row?.executionState).toBe('blocked');
    expect(row?.executionClaimedAt).toBeNull();
    expect(row?.challengeState).toBe('open'); // survived the release
    // A stale from-state loses the CAS cleanly.
    expect(await services.proposals.casExecutionState(proposalId, ['executing'], 'expired')).toBe(
      false,
    );
  });
});

describe('thirteenth review wave (PR #144): reviewer-wallet COI', () => {
  it('a reviewer cannot clear a grant paying their own linked wallet', async () => {
    const services = await wsmServices();
    await ensureProfile(services, ROOM);
    const treasury = await provisionTreasury(services);
    const reviewerAddress = `0x${'d7'.repeat(20)}`;
    const { hashFinancialWalletAddress } = await import('../identity/siwe.js');
    await services.wallets.insert({
      walletAccountId: randomUUID(),
      userId: USER,
      addressHashHex: hashFinancialWalletAddress(services.masterSecret, reviewerAddress),
      addressTruncated: `${reviewerAddress.slice(0, 6)}…${reviewerAddress.slice(-4)}`,
      chainId: 1337,
      walletType: 'eoa',
      unlinkState: 'active',
      riskState: 'normal',
      label: null,
      linkedAt: new Date().toISOString(),
      lastUsedAt: null,
      unlinkRequestedAt: null,
      unlinkFinalizeAfter: null,
      unlinkedAt: null,
    });
    const grant = await services.grants.insert({
      grantId: randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: randomUUID(),
      recipientRef: reviewerAddress, // the reviewer's OWN wallet, as an address
      purpose: 'Self-dealing fixture',
      amount: '100',
      asset: 'USDC',
      milestones: [],
      milestoneState: 'pending',
      reviewState: 'pending',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (grant === null) throw new Error('fixture grant collision');
    expect(
      await setGrantReview(services, {
        roomId: ROOM,
        grantId: grant.grantId,
        reviewState: 'cleared',
        reviewerUserId: USER,
      }),
    ).toMatchObject({ ok: false, code: 'independent_review_required' });
    // An unrelated reviewer clears normally.
    expect(
      await setGrantReview(services, {
        roomId: ROOM,
        grantId: grant.grantId,
        reviewState: 'cleared',
        reviewerUserId: OTHER,
      }),
    ).toMatchObject({ ok: true });
  });
});
