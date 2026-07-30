// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M services container + scheduler: the REAL port builders (membership
// facts from the forum subscription + in-context governance participation +
// identity verification; the WS-U kernel executor adapter; the forced-election
// rotation port), the singleton lifecycle, and the runWsmTick sweeps with
// per-task failure isolation (one broken sweep never blocks the rest).

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryAiGovernanceServices,
  setAiGovernanceServices,
} from '../ai-governance/services.js';
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
import { freshForumServices } from './forum-test-helpers.js';
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

  it('re-projects an all-rejected grant that nothing else can reach', async () => {
    // The sweep existed and was tested; the TICK CALLING IT was not, which is the
    // same shape of gap that let the bug in — a mechanism with no proof that
    // production reaches it.  Replacing the call with a no-op left every other
    // test green, so this is the assertion that holds the wiring.
    //
    // An all-rejected grant has no payment intent, so `reconcileIntents` sweeps
    // intents and never sees it, no finality ever arrives to re-project it, and the
    // milestone route's inline projection is deliberately non-fatal.  Without this
    // sweep the grant stays outside paid/clawed_back for ever and
    // `listUnsettledByRecipient` keeps blocking the recipient's last wallet unlink.
    const services = await wsmServices();
    const treasury = await services.treasuries.insert({
      treasuryId: randomUUID(),
      roomId: ROOM,
      deploymentId: randomUUID(),
      treasuryAddress: `0x${'a'.repeat(40)}`,
      acceptedAssets: ['USDC'],
      balanceSnapshot: { USDC: '0' },
      balancesReconciledAt: new Date().toISOString(),
      depositLimits: {
        perUserPerPeriod: '1000',
        perRoomPerPeriod: '10000',
        perDepositMax: '500',
        periodSeconds: 86_400,
      },
      freezeState: 'active',
      freezeReason: null,
      freezeCascade: false,
      pauseFlags: { deposits: false, proposals: false, executions: false },
      reconciliationState: 'synced',
      createdAt: new Date().toISOString(),
    });
    if (treasury === null) throw new Error('fixture treasury collision');
    const grantId = randomUUID();
    const recipientRef = `user:${USER}`;
    await services.grants.insert({
      grantId,
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: randomUUID(),
      recipientRef,
      purpose: 'Every tranche refused',
      amount: '100',
      asset: 'USDC',
      milestones: [
        {
          milestoneId: randomUUID(),
          description: 'Refused tranche',
          amount: '100',
          state: 'rejected',
          paymentIntentId: null,
        },
      ],
      milestoneState: 'rejected',
      reviewState: 'cleared',
      // The state a swallowed projection failure leaves behind.
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    expect(await services.grants.listUnsettledByRecipient(recipientRef, 10)).not.toEqual([]);

    const onError = vi.fn();
    await runWsmTick(services, onError);

    expect(onError).not.toHaveBeenCalled();
    expect((await services.grants.getById(grantId))?.payoutState).toBe('closed');
    expect(await services.grants.listUnsettledByRecipient(recipientRef, 10)).toEqual([]);
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

  it('isolates ONE poison room: every room after it still settles', async () => {
    const services = await wsmServices();
    const POISON_ROOM = '99999999-9999-4999-8999-999999999999';
    // The poison room is enumerated FIRST: the regression this pins is a room
    // whose settlement throws aborting the sweep for every room ORDERED AFTER
    // it — and since the next tick restarts at the same room, permanently.
    for (const roomId of [POISON_ROOM, ROOM]) {
      await services.profiles.upsert({
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
        updatedAt: new Date().toISOString(),
      });
    }
    const proposalId = randomUUID();
    await services.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'capped_grant',
      title: 'Settles behind the poison room',
      plainLanguageSummary: 'Its deliberation window has closed.',
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
    // `settleDueProposals` reads the room's profile first, so a malformed row
    // throws there — the shape of a single bad record, not of a dead store.
    const realGet = services.profiles.get.bind(services.profiles);
    services.profiles.get = async (roomId: string) => {
      if (roomId === POISON_ROOM) throw new Error('malformed governance profile');
      return realGet(roomId);
    };

    const failures: WsmSchedulerTask[] = [];
    await runWsmTick(services, (_error, task) => failures.push(task));

    // Reported once, for the one room that failed…
    expect(failures).toEqual(['wsm_proposal_settle']);
    // …and the healthy room behind it still reached its deadline.
    expect((await services.proposals.getById(proposalId))?.votingState).toBe('open');
  });

  it('isolates ONE poison treasury: every treasury after it still reconciles', async () => {
    const services = await wsmServices();
    const POISON_TREASURY = randomUUID();
    const HEALTHY_TREASURY = randomUUID();
    // Distinct rooms AND distinct addresses: the store enforces one treasury
    // per room and a unique address, so a shared fixture address silently
    // inserts nothing.
    for (const [index, treasuryId] of [POISON_TREASURY, HEALTHY_TREASURY].entries()) {
      await services.treasuries.insert({
        treasuryId,
        roomId: randomUUID(),
        deploymentId: randomUUID(),
        treasuryAddress: `0x${String(index).repeat(40)}`,
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
    }
    const realGetById = services.treasuries.getById.bind(services.treasuries);
    services.treasuries.getById = async (treasuryId: string) => {
      if (treasuryId === POISON_TREASURY) throw new Error('unreadable treasury row');
      return realGetById(treasuryId);
    };

    const failures: WsmSchedulerTask[] = [];
    await runWsmTick(services, (_error, task) => failures.push(task));

    expect(failures).toEqual(['wsm_treasury_reconcile']);
    // An unreconciled treasury blocks its room's new spend proposals, so the
    // tail of the list must not inherit the poison row's failure.
    const healthy = (await services.treasuries.listAll()).find(
      (t) => t.treasuryId === HEALTHY_TREASURY,
    );
    expect(healthy?.reconciliationState).toBe('synced');
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
    // Break every intent sweep: reconcile, expiry, AND the reorg-recovery pass
    // each report separately, and the treasury reconciliation still runs
    // afterwards.  (The tick RECOVERS before it reaps — reconcile attaches a
    // died-mid-flow client's durable action, W13; expiry abandons only what is
    // genuinely dead; the reorg-recovery pass abandons a reorg past its grace
    // window — so the failures report in sweep order.  This test is about the
    // failures being independent; the order is the sweep order.)
    services.intents.listExpired = async () => {
      throw new Error('expiry down');
    };
    services.intents.listByStates = async () => {
      throw new Error('reconcile down');
    };
    const failures: WsmSchedulerTask[] = [];
    await runWsmTick(services, (_error, task) => failures.push(task));
    expect(failures).toEqual([
      'wsm_intent_reconcile',
      'wsm_intent_expiry',
      'wsm_intent_reorg_recovery',
    ]);
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
  const forumOf = (
    subscription: { status: string; requestedAt: string; joinedAt?: string } | null,
  ): ForumServices =>
    ({
      rooms: {
        getSubscription: async () => subscription,
        countEligibleVoters: async () => 42,
      },
    }) as unknown as ForumServices;
  /** A boolean keeps the pre-freeze callers reading naturally; the object form
   *  carries `emailVerifiedAt`, which is what the freeze compares against.  Note the
   *  boolean form leaves it ABSENT — i.e. unknown, which the freeze admits. */
  const identityOf = (
    auth: boolean | { emailVerified: boolean; emailVerifiedAt: string | null } = true,
  ): IdentityServices =>
    ({
      store: {
        getAuth: async () => (typeof auth === 'boolean' ? { emailVerified: auth } : auth),
      },
    }) as unknown as IdentityServices;

  it('derives facts from the subscription age + in-context participation', async () => {
    const fixture = await freshKnomosisServices();
    const countSpy = vi
      .spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor')
      .mockResolvedValue(7);
    const joinedAt = new Date(fixture.knomosis.now() - 60 * 86_400_000).toISOString();
    const port = buildMembershipFactsPort(
      forumOf({ status: 'active', requestedAt: joinedAt, joinedAt }),
      identityOf(true),
      fixture.knomosis,
    );
    const facts = await port.memberFacts(ROOM, USER);
    // `memberSince` is the INSTANT, not the derived age: an electorate frozen at
    // an election's open compares join times against that open, and a day count
    // taken "now" cannot answer that question after the fact.
    expect(facts).toEqual({
      membershipDays: 60,
      contributionCount: 7,
      verifiedIdentity: true,
      memberSince: joinedAt,
    });
    // `undefined` is the LIVE instant — the third argument is the electorate freeze's
    // `asOf`, absent here because nothing froze.
    expect(countSpy).toHaveBeenCalledWith(ROOM, USER, undefined);
    expect(await port.eligibleMemberCount(ROOM)).toBe(42);
  });

  it('an UNKNOWN join is unjudgeable for the freeze, but still has an age', async () => {
    // Every production writer of an active subscription stamps `joinedAt`, so a
    // null is a row from before the field.  The two answers take the fallback
    // differently on purpose: for the FREEZE, judging it by `requestedAt` would
    // answer with the one instant already known to be wrong, so it reports
    // unknown and the ballot gate admits it — as it admits a steward whose seat
    // carries no join instant.  For the AGE, `requestedAt` is the pre-existing
    // estimate; a null there fails a treasury-controlling vote CLOSED and would
    // lock the member out entirely.
    const fixture = await freshKnomosisServices();
    vi.spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor').mockResolvedValue(0);
    const port = buildMembershipFactsPort(
      forumOf({
        status: 'active',
        requestedAt: new Date(fixture.knomosis.now() - 10 * 86_400_000).toISOString(),
      }),
      identityOf(true),
      fixture.knomosis,
    );
    const facts = await port.memberFacts(ROOM, USER);
    expect(facts?.memberSince ?? null).toBeNull();
    expect(facts?.membershipDays).toBe(10);
  });

  it('the basis is counted AS OF the freeze instant, not live beside it', async () => {
    // A count taken live and an instant stamped beside it are two answers to
    // one question, and the gap between them is the sweep's own runtime: a
    // member joining inside it lands in the denominator and outside the ballot
    // cutoff, which is exactly the mismatch the freeze exists to remove.
    // Passing the instant INTO the count closes it by construction.
    const fixture = await freshKnomosisServices();
    const asOf = new Date(fixture.knomosis.now()).toISOString();
    const seen: Array<string | undefined> = [];
    const port = buildMembershipFactsPort(
      {
        rooms: {
          getSubscription: async () => null,
          countEligibleVoters: async (_r: string, joinedBefore?: string) => {
            seen.push(joinedBefore);
            return 7;
          },
        },
      } as unknown as ForumServices,
      identityOf(true),
      fixture.knomosis,
    );
    // The trivial arm (no rules) still carries the instant — it is the SAME
    // denominator either way.
    expect(await port.eligibleMemberCount(ROOM, undefined)).toBe(7);
    expect(seen).toEqual([undefined]);
    expect(
      await port.eligibleMemberCount(ROOM, {
        rules: {
          minMembershipDays: 0,
          minContributions: 0,
          requireVerifiedIdentity: false,
          newWalletCoolingOffDays: 0,
        },
        treasuryControlling: false,
        asOf,
      }),
    ).toBe(7);
    expect(seen[1]).toBe(asOf);
  });

  it('membership age and the freeze both read JOINED, not REQUESTED', async () => {
    // In an approval-gated room the two are far apart, and reading the request
    // instant makes both answers wrong in the same direction: a `minMembershipDays`
    // of 30 is satisfied by an account that has been an actual member for a day,
    // and the electorate freeze admits a ballot from someone who was still
    // pending — and therefore outside the frozen denominator — when the vote
    // opened.
    const fixture = await freshKnomosisServices();
    vi.spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor').mockResolvedValue(0);
    // ONE read of the clock.  `knomosis.now()` is live here, so calling it once
    // to build the fixture and again to assert compares two different instants
    // — which failed by a millisecond in CI, and is the very mistake the code
    // under test exists to prevent.
    const now = fixture.knomosis.now();
    const joinedAt = new Date(now - 86_400_000).toISOString();
    const port = buildMembershipFactsPort(
      forumOf({
        status: 'active',
        // Asked a year ago…
        requestedAt: new Date(now - 365 * 86_400_000).toISOString(),
        // …admitted yesterday.
        joinedAt,
      }),
      identityOf(true),
      fixture.knomosis,
    );
    const facts = await port.memberFacts(ROOM, USER);
    expect(facts?.membershipDays).toBe(1);
    expect(facts?.memberSince).toBe(joinedAt);
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

  // The freeze covered only `memberSince`.  Tenure, contributions and identity were
  // read LIVE, so a member the frozen basis EXCLUDED for any of those could satisfy
  // the rule mid-window and then vote against a denominator they were never counted
  // in — satisfying quorum, or turning a treasury decision, against a smaller frozen
  // figure.
  it('counts TENURE at the frozen instant, not at the ballot', async () => {
    const fixture = await freshKnomosisServices();
    vi.spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor').mockResolvedValue(0);
    // Joined 10 days ago; the basis was frozen 5 days ago.
    const joinedAt = new Date(fixture.knomosis.now() - 10 * 86_400_000).toISOString();
    const frozenAt = new Date(fixture.knomosis.now() - 5 * 86_400_000).toISOString();
    const port = buildMembershipFactsPort(
      forumOf({ status: 'active', joinedAt, requestedAt: joinedAt }),
      identityOf(),
      fixture.knomosis,
    );
    expect((await port.memberFacts(ROOM, USER))?.membershipDays).toBe(10);
    // AS OF the freeze the member had only 5 days of tenure — which is what a
    // `minMembershipDays: 7` pack must judge them on.
    expect((await port.memberFacts(ROOM, USER, frozenAt))?.membershipDays).toBe(5);
  });

  it('counts CONTRIBUTIONS at the frozen instant', async () => {
    const fixture = await freshKnomosisServices();
    const countSpy = vi
      .spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor')
      .mockResolvedValue(3);
    const joinedAt = new Date(fixture.knomosis.now() - 60 * 86_400_000).toISOString();
    const frozenAt = new Date(fixture.knomosis.now() - 5 * 86_400_000).toISOString();
    const port = buildMembershipFactsPort(
      forumOf({ status: 'active', joinedAt, requestedAt: joinedAt }),
      identityOf(),
      fixture.knomosis,
    );
    await port.memberFacts(ROOM, USER, frozenAt);
    // The bound reaches the store, so contributions made after the freeze cannot
    // qualify a member the frozen basis excluded.
    expect(countSpy).toHaveBeenCalledWith(ROOM, USER, frozenAt);
  });

  it('treats identity verified AFTER the freeze as unverified then', async () => {
    const fixture = await freshKnomosisServices();
    vi.spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor').mockResolvedValue(0);
    const joinedAt = new Date(fixture.knomosis.now() - 60 * 86_400_000).toISOString();
    const frozenAt = new Date(fixture.knomosis.now() - 5 * 86_400_000).toISOString();
    const verifiedAfter = new Date(fixture.knomosis.now() - 1 * 86_400_000).toISOString();
    const port = buildMembershipFactsPort(
      forumOf({ status: 'active', joinedAt, requestedAt: joinedAt }),
      identityOf({ emailVerified: true, emailVerifiedAt: verifiedAfter }),
      fixture.knomosis,
    );
    expect((await port.memberFacts(ROOM, USER))?.verifiedIdentity).toBe(true);
    expect((await port.memberFacts(ROOM, USER, frozenAt))?.verifiedIdentity).toBe(false);
  });

  it('UNKNOWN stays admissible: a null emailVerifiedAt passes the freeze', async () => {
    // A row from before that field existed cannot be shown to postdate the freeze.
    // Treating it as unverified would refuse every such member on a
    // `requireVerifiedIdentity` pack — a governance lockout with no error they could
    // act on, and the same reasoning `memberSince` already uses for its own null.
    const fixture = await freshKnomosisServices();
    vi.spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor').mockResolvedValue(0);
    const joinedAt = new Date(fixture.knomosis.now() - 60 * 86_400_000).toISOString();
    const frozenAt = new Date(fixture.knomosis.now() - 5 * 86_400_000).toISOString();
    const port = buildMembershipFactsPort(
      forumOf({ status: 'active', joinedAt, requestedAt: joinedAt }),
      identityOf({ emailVerified: true, emailVerifiedAt: null }),
      fixture.knomosis,
    );
    expect((await port.memberFacts(ROOM, USER, frozenAt))?.verifiedIdentity).toBe(true);
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

  it('a REORGED intent holds no unlink obligation — the transfer reversed (W14)', async () => {
    const services = await wsmServices();
    const { buildTreasuryObligationsPort } = await import('../treasury/services.js');
    const port = buildTreasuryObligationsPort(services);
    const walletAccountId = randomUUID();
    await services.wallets.insert({
      walletAccountId,
      userId: USER,
      addressHashHex: 'j'.repeat(64),
      addressTruncated: '0xaaaa…bbbb',
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
    const intentOf = (executionState: 'confirmed' | 'reorged') => ({
      paymentIntentId: randomUUID(),
      userId: USER,
      roomId: ROOM,
      treasuryId: randomUUID(),
      targetType: 'treasury_deposit' as const,
      targetId: randomUUID(),
      asset: 'USDC',
      amount: '100',
      jurisdictionState: 'allowed' as const,
      complianceState: 'cleared' as const,
      executionState,
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: null,
      idempotencyKey: randomUUID(),
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // A reorged intent already REVERSED — it must not pin the last wallet.
    await services.intents.insert(intentOf('reorged'));
    expect(await port.obligationsForWallet(walletAccountId)).toEqual([]);
    // A genuinely in-flight intent still does.
    await services.intents.insert(intentOf('confirmed'));
    const blocked = await port.obligationsForWallet(walletAccountId);
    expect(blocked.some((o) => o.type === 'pending_payment')).toBe(true);
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

  it('THREADS the freeze instant to the count, rather than dropping it', async () => {
    // `scheduleElection` captures the instant it will record as `opensAt` and
    // hands it to this callback.  A callback typed to take only `roomId`
    // silently discards it and counts LIVE — so a member joining after
    // `opensAt` but before the query returns lands in `eligibleCount` while
    // `castElectionVote` refuses them for `joinedAt > opensAt`: a denominator
    // padded with someone who cannot vote.  A forced rotation is exactly when a
    // room is in flux, so it is the path least able to afford the gap.
    const seen: Array<string | undefined> = [];
    const service = {
      scheduleElection: async (
        roomId: string,
        options: { eligibleVoterCount?: (room: string, asOf: string) => Promise<number> },
      ) => {
        await options.eligibleVoterCount?.(roomId, '2026-07-29T12:00:00.000Z');
        return { ok: true } as const;
      },
    } as unknown as GovernanceService;
    const port = buildStewardElectionPort(service, async (_room, asOf) => {
      seen.push(asOf);
      return 3;
    });
    expect(await port.openElection(ROOM)).toBe(true);
    expect(seen).toEqual(['2026-07-29T12:00:00.000Z']);
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

  it('a ZERO-WEIGHT member leaves the basis, so reputation_bounded quorum stays reachable', async () => {
    // The deadlock.  `signProposal` REFUSES a zero-weight ballot (a `0` adds
    // nothing to approve/reject, so recording one would let an all-zero
    // electorate read as unanimous approval), and quorum is measured in DISTINCT
    // RECORDED VOTERS.  Under `reputation_bounded` a member with no qualifying
    // contributions resolves to weight zero — yet still passes
    // `checkVoterEligibility` when `minContributions` is 0, so they entered the
    // frozen denominator.  Enough such members and quorum was unreachable even
    // if every eligible member tried to vote.
    const fixture = await freshKnomosisServices();
    const now = fixture.knomosis.now();
    const joined = new Date(now - 90 * 86_400_000).toISOString();
    // `reputationScore` is the member's qualifying-contribution count.
    vi.spyOn(fixture.knomosis.governanceAudit, 'countQualifyingByRoomActor').mockImplementation(
      async (_room: string, userId: string) => (userId === 'contributor' ? 5 : 0),
    );
    const port = buildMembershipFactsPort(
      forumOf({ contributor: { requestedAt: joined }, lurker: { requestedAt: joined } }),
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
    const rules = {
      minMembershipDays: 0,
      minContributions: 0,
      requireVerifiedIdentity: false,
      newWalletCoolingOffDays: 0,
    };
    // Both members pass the law-pack predicate…
    expect(await port.eligibleMemberCount(ROOM, { rules, treasuryControlling: false })).toBe(2);
    // …but under `reputation_bounded` only the contributor can record a ballot,
    // so only the contributor is the electorate.
    expect(
      await port.eligibleMemberCount(ROOM, {
        rules,
        treasuryControlling: false,
        weight: { model: 'reputation_bounded', maxVotingWeightPerAccount: 10 },
      }),
    ).toBe(1);
    // A model whose weight can never be zero keeps the whole membership, and
    // keeps the fast count — the walk is only for the models that need it.
    expect(
      await port.eligibleMemberCount(ROOM, {
        rules,
        treasuryControlling: false,
        weight: { model: 'one_civic_account_one_vote', maxVotingWeightPerAccount: 1 },
      }),
    ).toBe(2);
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

describe('governanceAdvisor (the SHIPPED closure, §24.5)', () => {
  // Nothing drove this closure before: `treasury-proposals.test.ts` assigns a
  // stub `deps.governanceAdvisor`, and this file never mentioned it — so the
  // per-capability isolation it claims was untested as well as incomplete.
  async function advisorFixture() {
    const forum = freshForumServices();
    const ai = createInMemoryAiGovernanceServices(forum.events, { now: () => Date.now() });
    setAiGovernanceServices(ai);
    return { ai, services: await wsmServices() };
  }

  const PROPOSER = 'user-a';
  const SCAM_TEXT = 'guaranteed returns — send funds to me now';

  it('persists BOTH advisories and the summary on ordinary input', async () => {
    const { ai, services } = await advisorFixture();
    await services.governanceAdvisor?.({
      proposalRef: 'prop-1',
      roomId: ROOM,
      proposerRef: PROPOSER,
      recipientRef: PROPOSER, // proposer IS recipient ⇒ conflict of interest
      fields: { purpose: 'buy servers', amount: '100', recipient: PROPOSER },
      text: SCAM_TEXT,
    });
    const advisories = await ai.governanceAdvisories.listByProposal('prop-1');
    expect(advisories.map((a) => a.kind).sort()).toEqual(['coi_highlight', 'scam_pattern']);
    expect(await ai.governanceSummaries.listByProposal('prop-1')).toHaveLength(1);
  });

  it('a PADDED field can no longer silence the advisories', async () => {
    // The attack: `requested_action` is the one unbounded field of
    // `productionProposalCreateSchema`, it reaches `summarizeProposal` verbatim,
    // and the summary body was capped at 8,000 — so a long value made the
    // summarizer throw from OUTSIDE the isolation loop and both advisories were
    // lost.  The proposer who is also the recipient could suppress their own
    // conflict-of-interest flag by padding a field.
    const { ai, services } = await advisorFixture();
    await expect(
      services.governanceAdvisor?.({
        proposalRef: 'prop-2',
        roomId: ROOM,
        proposerRef: PROPOSER,
        recipientRef: PROPOSER,
        fields: { purpose: 'buy servers', citations: 'x'.repeat(9_000), recipient: PROPOSER },
        text: SCAM_TEXT,
      }),
    ).resolves.toBeUndefined();
    const advisories = await ai.governanceAdvisories.listByProposal('prop-2');
    expect(advisories.map((a) => a.kind).sort()).toEqual(['coi_highlight', 'scam_pattern']);
    // …and the summary itself survived, truncated rather than refused.
    const [summary] = await ai.governanceSummaries.listByProposal('prop-2');
    expect(summary).toBeDefined();
    expect(summary?.body.length).toBeLessThanOrEqual(8_000);
    expect(summary?.body).toContain('…');
  });

  it('a summarizer failure no longer costs the advisories', async () => {
    // The containment, independent of the input bound above: the summary is a
    // §24.5 capability with its own guard and its own store, so it belongs in the
    // isolation loop rather than three lines above it.
    const { ai, services } = await advisorFixture();
    ai.governanceSummaries.put = async () => {
      throw new Error('summary store unavailable');
    };
    await services.governanceAdvisor?.({
      proposalRef: 'prop-3',
      roomId: ROOM,
      proposerRef: PROPOSER,
      recipientRef: PROPOSER,
      fields: { purpose: 'buy servers', recipient: PROPOSER },
      text: SCAM_TEXT,
    });
    const advisories = await ai.governanceAdvisories.listByProposal('prop-3');
    expect(advisories.map((a) => a.kind).sort()).toEqual(['coi_highlight', 'scam_pattern']);
  });
});
