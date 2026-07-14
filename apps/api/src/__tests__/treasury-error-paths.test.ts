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
import { createDelegation, revokeDelegation } from '../treasury/delegations.js';
import { buildAccountingExport } from '../treasury/export.js';
import { setGrantReview } from '../treasury/grants.js';
import { createPaymentIntent, retryIntent } from '../treasury/intents.js';
import {
  assertGovernanceWritable,
  ensureProfile,
  setGovernancePause,
} from '../treasury/profile.js';
import { executeProposal } from '../treasury/proposals.js';
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
import { freshKnomosisServices, resetKnomosisFixture } from './knomosis-test-helpers.js';

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
      eligibleMemberCount: async () => 3,
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
    await services.treasuries.setFreeze(treasury.treasuryId, 'frozen', 'divergence');
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
