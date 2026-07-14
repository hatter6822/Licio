// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M services container + scheduler: the REAL port builders (membership
// facts from the forum subscription + in-context governance participation +
// identity verification; the WS-U kernel executor adapter; the forced-election
// rotation port), the singleton lifecycle, and the runWsmTick sweeps with
// per-task failure isolation (one broken sweep never blocks the rest).

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForumServices } from '../forum/services.js';
import type { GovernanceService } from '../governance/service.js';
import { createInMemoryGovernanceStores } from '../governance/stores.js';
import type { IdentityServices } from '../identity/services.js';
import { runWsmTick, type WsmSchedulerTask } from '../treasury/scheduler.js';
import {
  buildMembershipFactsPort,
  buildStewardElectionPort,
  buildTreasuryExecutorPort,
  createInMemoryTreasuryServices,
  getTreasuryServices,
  resetTreasuryServicesForTests,
  setTreasuryServices,
  type TreasuryServices,
  treasuryServicesConfigured,
} from '../treasury/services.js';
import type { PaymentIntentRecord } from '../treasury/stores.js';
import { freshKnomosisServices, resetKnomosisFixture } from './knomosis-test-helpers.js';

const ROOM = '77777777-7777-4777-8777-777777777777';
const USER = '88888888-8888-4888-8888-888888888888';

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

function intentOf(over: Partial<PaymentIntentRecord> = {}): PaymentIntentRecord {
  return {
    paymentIntentId: randomUUID(),
    userId: USER,
    roomId: ROOM,
    treasuryId: randomUUID(),
    targetType: 'treasury_deposit',
    targetId: randomUUID(),
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

afterEach(() => {
  resetTreasuryServicesForTests();
  resetKnomosisFixture();
});

describe('runWsmTick (WS-M sweeps)', () => {
  it('abandons expired pre-submission intents and settles due proposals', async () => {
    const services = await wsmServices();
    const expired = intentOf();
    await services.intents.insert(expired);

    // A production proposal whose deliberation window has ended.
    const proposalId = randomUUID();
    await services.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'capped_grant',
      title: 'Sweep fixture',
      plainLanguageSummary: 'Settles at the deadline.',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'Low.',
      requestedAction: {},
      expectedDeliverable: 'None.',
      preflightState: 'passed',
      votingState: 'deliberation',
      challengeState: 'none',
      executionState: 'not_executed',
      simulationMode: false,
      executableAfter: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
      lawPackVersionId: null,
      category: null,
      deliberationEndsAt: new Date(Date.now() - 1_000).toISOString(),
      votingEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
      challengeWindowEndsAt: null,
      tallySnapshot: null,
    });
    // The proposal sweep walks every governed room via the profile list.
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

    const onError = vi.fn();
    await runWsmTick(services, onError);

    expect(onError).not.toHaveBeenCalled();
    expect((await services.intents.getById(expired.paymentIntentId))?.executionState).toBe(
      'abandoned',
    );
    expect((await services.proposals.getById(proposalId))?.votingState).toBe('open');
  });

  it('isolates a failing sweep: the rest still run and the error is reported', async () => {
    const services = await wsmServices();
    const expired = intentOf();
    await services.intents.insert(expired);
    // Break the proposal sweep's room enumeration.
    services.profiles.listAll = async () => {
      throw new Error('profiles down');
    };

    const failures: WsmSchedulerTask[] = [];
    await runWsmTick(services, (_error, task) => failures.push(task));

    expect(failures).toEqual(['wsm_proposal_settle']);
    // The intent sweep before it and the treasury sweep after it both ran.
    expect((await services.intents.getById(expired.paymentIntentId))?.executionState).toBe(
      'abandoned',
    );
  });

  it('reconciles every treasury and reports intent-sweep failures independently', async () => {
    const services = await wsmServices();
    await services.treasuries.insert({
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
      reconciliationState: 'pending',
      createdAt: new Date().toISOString(),
    });
    // Break both intent sweeps: expiry AND reconcile each report separately,
    // and the treasury reconciliation still runs afterwards.
    services.intents.listExpired = async () => {
      throw new Error('expiry down');
    };
    services.intents.listByStates = async () => {
      throw new Error('reconcile down');
    };
    const failures: WsmSchedulerTask[] = [];
    await runWsmTick(services, (_error, task) => failures.push(task));
    expect(failures).toEqual(['wsm_intent_expiry', 'wsm_intent_reconcile']);
    // The empty ledger reconciles to synced: the sweep reached the treasury.
    const [treasury] = await services.treasuries.listAll();
    expect(treasury?.reconciliationState).toBe('synced');
  });

  it('reports a treasury-reconciliation failure through its own task label', async () => {
    const services = await wsmServices();
    services.treasuries.listAll = async () => {
      throw new Error('treasuries down');
    };
    const failures: WsmSchedulerTask[] = [];
    await runWsmTick(services, (_error, task) => failures.push(task));
    expect(failures).toEqual(['wsm_treasury_reconcile']);
  });
});

describe('buildMembershipFactsPort (WS-M.4.2c-2)', () => {
  const forumOf = (subscription: { status: string; requestedAt: string } | null): ForumServices =>
    ({
      rooms: {
        getSubscription: async () => subscription,
        countEligibleVoters: async () => 42,
      },
    }) as unknown as ForumServices;
  const identityOf = (emailVerified: boolean): IdentityServices =>
    ({ store: { getAuth: async () => ({ emailVerified }) } }) as unknown as IdentityServices;

  it('derives facts from the subscription age + in-context participation', async () => {
    const fixture = await freshKnomosisServices();
    const countSpy = vi
      .spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor')
      .mockResolvedValue(7);
    const port = buildMembershipFactsPort(
      forumOf({
        status: 'active',
        requestedAt: new Date(fixture.knomosis.now() - 60 * 86_400_000).toISOString(),
      }),
      identityOf(true),
      fixture.knomosis,
    );
    const facts = await port.memberFacts(ROOM, USER);
    expect(facts).toEqual({ membershipDays: 60, contributionCount: 7, verifiedIdentity: true });
    expect(countSpy).toHaveBeenCalledWith(ROOM, USER);
    expect(await port.eligibleMemberCount(ROOM)).toBe(42);
  });

  it('returns null facts for a missing or inactive subscription (fail-closed)', async () => {
    const fixture = await freshKnomosisServices();
    const none = buildMembershipFactsPort(forumOf(null), identityOf(true), fixture.knomosis);
    expect(await none.memberFacts(ROOM, USER)).toBeNull();
    const pending = buildMembershipFactsPort(
      forumOf({ status: 'pending', requestedAt: new Date().toISOString() }),
      identityOf(true),
      fixture.knomosis,
    );
    expect(await pending.memberFacts(ROOM, USER)).toBeNull();
  });

  it('treats an unverified (or missing) email as unverified identity', async () => {
    const fixture = await freshKnomosisServices();
    vi.spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor').mockResolvedValue(0);
    const port = buildMembershipFactsPort(
      forumOf({ status: 'active', requestedAt: new Date().toISOString() }),
      { store: { getAuth: async () => null } } as unknown as IdentityServices,
      fixture.knomosis,
    );
    const facts = await port.memberFacts(ROOM, USER);
    expect(facts?.verifiedIdentity).toBe(false);
    expect(facts?.membershipDays).toBe(0);
  });
});

describe('buildTreasuryObligationsPort (WS-L.2.5b, W12)', () => {
  it('blocks unlinking the LAST wallet while a user: grant or intent is live', async () => {
    const services = await wsmServices();
    const { buildTreasuryObligationsPort } = await import('../treasury/services.js');
    const port = buildTreasuryObligationsPort(services);
    const walletAccountId = randomUUID();
    await services.wallets.insert({
      walletAccountId,
      userId: USER,
      addressHashHex: 'h'.repeat(64),
      addressTruncated: '0xabcd…ef01',
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
    // No obligations yet.
    expect(await port.obligationsForWallet(walletAccountId)).toEqual([]);
    // An unsettled grant payable to the member blocks the LAST wallet.
    const treasury = await (async () => {
      const record = {
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
        freezeState: 'active' as const,
        freezeReason: null,
        freezeCascade: false,
        pauseFlags: { deposits: false, proposals: false, executions: false },
        reconciliationState: 'synced' as const,
        createdAt: new Date().toISOString(),
      };
      const inserted = await services.treasuries.insert(record);
      if (inserted === null) throw new Error('fixture treasury collision');
      return inserted;
    })();
    await services.grants.insert({
      grantId: randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: randomUUID(),
      recipientRef: `user:${USER}`,
      purpose: 'Pending payout',
      amount: '100',
      asset: 'USDC',
      milestones: [],
      milestoneState: 'pending',
      reviewState: 'cleared',
      payoutState: 'scheduled',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    const blocked = await port.obligationsForWallet(walletAccountId);
    expect(blocked.some((o) => o.type === 'pending_grant')).toBe(true);
    // A SECOND active wallet satisfies the payout binding — unlink frees up.
    await services.wallets.insert({
      walletAccountId: randomUUID(),
      userId: USER,
      addressHashHex: 'i'.repeat(64),
      addressTruncated: '0xdcba…10fe',
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
    expect(await port.obligationsForWallet(walletAccountId)).toEqual([]);
  });
});

describe('buildTreasuryExecutorPort (the WS-U kernel adapter)', () => {
  const serviceOf = (
    result:
      | { ok: true; value: { accepted: boolean; code: string | null } }
      | { ok: false; code: string; message: string },
  ): GovernanceService =>
    ({ executeTreasuryAction: async () => result }) as unknown as GovernanceService;

  const ACTION = {
    category: 'grant',
    amount: '100',
    asset: 'USDC',
    coiDeclared: true,
    proposedAt: new Date().toISOString(),
  };

  it('maps kernel acceptance, kernel refusal, and service failure', async () => {
    expect(
      await buildTreasuryExecutorPort(
        serviceOf({ ok: true, value: { accepted: true, code: null } }),
      ).execute(ROOM, ACTION),
    ).toEqual({ accepted: true, code: null });
    expect(
      await buildTreasuryExecutorPort(
        serviceOf({ ok: true, value: { accepted: false, code: 'cap_exceeded' } }),
      ).execute(ROOM, ACTION),
    ).toEqual({ accepted: false, code: 'cap_exceeded' });
    expect(
      await buildTreasuryExecutorPort(
        serviceOf({ ok: false, code: 'feature_disabled', message: 'off' }),
      ).execute(ROOM, ACTION),
    ).toEqual({ accepted: false, code: 'feature_disabled' });
  });
});

describe('buildStewardElectionPort (WS-M.4.3b rotation)', () => {
  const serviceOf = (
    result: { ok: true } | { ok: false; code: string; message: string },
  ): GovernanceService =>
    ({ scheduleElection: async () => result }) as unknown as GovernanceService;

  it('opens a forced election; an already-open election satisfies the intent', async () => {
    expect(await buildStewardElectionPort(serviceOf({ ok: true })).openElection(ROOM)).toBe(true);
    expect(
      await buildStewardElectionPort(
        serviceOf({ ok: false, code: 'election_open', message: 'running' }),
      ).openElection(ROOM),
    ).toBe(true);
    expect(
      await buildStewardElectionPort(
        serviceOf({ ok: false, code: 'feature_disabled', message: 'off' }),
      ).openElection(ROOM),
    ).toBe(false);
  });
});

describe('the treasury services singleton', () => {
  it('throws when unconfigured and flips configured on set', async () => {
    expect(treasuryServicesConfigured()).toBe(false);
    expect(() => getTreasuryServices()).toThrow(/not configured/);
    const services = await wsmServices();
    setTreasuryServices(services);
    expect(treasuryServicesConfigured()).toBe(true);
    expect(getTreasuryServices()).toBe(services);
  });
});

describe('eligibility-aware quorum basis (W3 review)', () => {
  const forumOf = (facts: Record<string, { requestedAt: string } | null>): ForumServices =>
    ({
      rooms: {
        getSubscription: async (_room: string, userId: string) =>
          facts[userId] ? { status: 'active', requestedAt: facts[userId]?.requestedAt } : null,
        countEligibleVoters: async () => Object.keys(facts).length,
        listEligibleVoterIds: async () => Object.keys(facts),
      },
    }) as unknown as ForumServices;

  it('filters members who fail the law-pack predicate out of the denominator', async () => {
    const fixture = await freshKnomosisServices();
    vi.spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor').mockResolvedValue(5);
    const now = fixture.knomosis.now();
    const old = new Date(now - 90 * 86_400_000).toISOString();
    const fresh = new Date(now - 2 * 86_400_000).toISOString();
    const port = buildMembershipFactsPort(
      forumOf({ veteran: { requestedAt: old }, newbie: { requestedAt: fresh } }),
      {
        store: {
          getAuth: async () => ({ emailVerified: true }),
          getUser: async () => ({ ageBand: 'adult' }),
          listWebauthn: async () => [],
          listWalletAuth: async () => [],
        },
      } as never,
      fixture.knomosis,
    );
    // Without rules: the raw electorate.
    expect(await port.eligibleMemberCount(ROOM)).toBe(2);
    // With a 30-day membership rule: the 2-day member leaves the denominator.
    expect(
      await port.eligibleMemberCount(ROOM, {
        rules: {
          minMembershipDays: 30,
          minContributions: 0,
          requireVerifiedIdentity: false,
          newWalletCoolingOffDays: 0,
        },
        treasuryControlling: true,
      }),
    ).toBe(1);
  });

  it('treasury-controlling counts skip the shortcut: null-facts members leave the basis (W9)', async () => {
    const fixture = await freshKnomosisServices();
    vi.spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor').mockResolvedValue(5);
    const now = fixture.knomosis.now();
    const old = new Date(now - 90 * 86_400_000).toISOString();
    // Two ids in the electorate; one (a steward with no active subscription)
    // has NULL member facts — signProposal rejects their treasury-controlling
    // ballot, so they must not inflate the spend-quorum denominator even
    // under TRIVIAL rules.
    const port = buildMembershipFactsPort(
      forumOf({ member: { requestedAt: old }, subless_steward: null }),
      {
        store: {
          getAuth: async () => ({ emailVerified: true }),
          getUser: async () => ({ ageBand: 'adult' }),
          listWebauthn: async () => [],
          listWalletAuth: async () => [],
        },
      } as never,
      fixture.knomosis,
    );
    const trivialRules = {
      minMembershipDays: 0,
      minContributions: 0,
      requireVerifiedIdentity: false,
      newWalletCoolingOffDays: 0,
    };
    // Non-treasury votes keep the cheap shortcut (both ids count)…
    expect(
      await port.eligibleMemberCount(ROOM, {
        rules: trivialRules,
        treasuryControlling: false,
      }),
    ).toBe(2);
    // …but a treasury-controlling basis walks the fail-closed gate.
    expect(
      await port.eligibleMemberCount(ROOM, {
        rules: trivialRules,
        treasuryControlling: true,
      }),
    ).toBe(1);
  });
});
