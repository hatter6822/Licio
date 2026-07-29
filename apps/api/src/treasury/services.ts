// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M services container (the house pattern): the eleven WS-M stores + the
// composed dependency object every treasury/governance service function takes,
// injectable at boot.  Routes read the module singleton via
// `getTreasuryServices()`; the production boot swaps the Postgres adapters in
// by assignment (createDrizzleTreasuryStores) and wires the REAL ports over
// the sibling services; tests build an in-memory container.
//
// Port wiring notes:
//  - `membership` reads the forum subscription (membership age), the KNOMOSIS
//    governance-audit participation count (an in-context metric — never a
//    cross-context content join), and the identity verification state.
//  - `treasuryExecutor` adapts the SHIPPED GovernanceService.executeTreasuryAction
//    (kernel verdict + capability + kill switch) — WS-M is its production caller.
//  - `elections` adapts scheduleElection(force) for community-voted rotations.

import type { WeightModel } from '@licio/governance';
import { checkVoterEligibility, decCompare, resolveVotingWeight } from '@licio/governance';

/**
 * The weight models whose resolution can be ZERO for an otherwise-eligible
 * member — the ones whose electorate therefore needs a per-member walk.
 *
 * `one_civic_account_one_vote` and `role_based_quorum` resolve `min(1, cap)` and
 * the cap is `.positive()`, so they are always above zero.  The token models are
 * §17.5-gated and refused wholesale at signing.  That leaves the
 * participation-denominated one, which is exactly the case that starved quorum.
 */
const WEIGHT_MODELS_THAT_CAN_RESOLVE_ZERO: ReadonlySet<WeightModel> = new Set([
  'reputation_bounded',
  'capped_token',
  'quadratic_capped',
]);

import {
  detectScamPatterns,
  highlightConflictOfInterest,
  summarizeProposal,
} from '../ai-governance/governance-ai.js';
import { tryGetAiGovernanceServices } from '../ai-governance/services.js';
import { buildGovernanceAiDeps } from '../ai-governance/wiring.js';
import type { ForumServices } from '../forum/services.js';
import type { GovernanceService } from '../governance/service.js';
import type { GovernanceStores } from '../governance/stores.js';
import { hasVerifiedCredential } from '../identity/auth-methods.js';
import { accountRef } from '../identity/crypto.js';
import type { IdentityServices } from '../identity/services.js';
import { authMethodInventory } from '../identity/services.js';
import type { ExternalObligation, TreasuryObligationsPort } from '../knomosis/ports.js';
import { canExpandForRoom } from '../knomosis/reconciliation.js';
import type { KnomosisServices } from '../knomosis/services.js';
import type {
  MembershipFactsPort,
  ProposalDeps,
  StewardElectionPort,
  TreasuryExecutorPort,
} from './proposals.js';
import type { WsmReadinessDeps } from './readiness.js';
import {
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
} from './stores.js';
import type { TreasuryReconciliationDeps } from './treasury-reconciliation.js';

/** Everything the WS-M service functions need, in one injectable bundle. */
export type TreasuryServices = ProposalDeps &
  WsmReadinessDeps &
  TreasuryReconciliationDeps & {
    alert: (event: string, meta: Record<string, unknown>) => void;
  };

/** The forum/identity/knomosis-backed membership facts (WS-M.4.2c-2). */
export function buildMembershipFactsPort(
  forum: ForumServices,
  identity: IdentityServices,
  knomosis: KnomosisServices,
): MembershipFactsPort {
  const memberFacts = async (roomId: string, userId: string) => {
    const subscription = await forum.rooms.getSubscription(roomId, userId);
    if (subscription === null || subscription.status !== 'active') return null;
    const auth = await identity.store.getAuth(userId);
    // MEMBERSHIP STARTS AT `joinedAt`, NOT AT THE REQUEST.  In an
    // approval-gated room the two can be far apart, and reading the request
    // instant reopened the electorate freeze it was added to close: an account
    // could ask to join BEFORE an election opened, sit pending — and therefore
    // outside the frozen denominator — be approved after, and then pass the
    // cutoff on the strength of a timestamp that predates a membership it did
    // not yet hold.
    //
    // The two answers below take the fallback DIFFERENTLY, and deliberately.
    // Every production writer of an active subscription stamps `joinedAt`
    // (room creation, join approval, the direct-join path), so a null here is a
    // row from before the field — and for the FREEZE the honest answer about
    // such a row is "unknown", which the ballot gate admits, exactly as it
    // admits a steward whose seat carries no join instant.  Judging it by
    // `requestedAt` instead would answer with the one instant already known to
    // be wrong.  For the AGE, the request instant is the pre-existing estimate
    // and keeps the row eligible; a null there fails a treasury-controlling
    // vote CLOSED and would lock the member out entirely.
    const memberSince = subscription.joinedAt;
    const ageFrom = memberSince ?? subscription.requestedAt;
    const membershipDays = Math.floor((knomosis.now() - Date.parse(ageFrom)) / 86_400_000);
    return {
      membershipDays: Number.isFinite(membershipDays) ? Math.max(0, membershipDays) : null,
      contributionCount: await knomosis.governanceAudit.countQualifyingByRoomActor(roomId, userId),
      verifiedIdentity: auth?.emailVerified === true,
      memberSince,
    };
  };
  return {
    memberFacts,
    eligibleMemberCount: async (roomId, eligibility) => {
      // Without rules the electorate is the room membership; with rules the
      // SAME predicate that gates ballots filters the quorum basis — members
      // who could never vote must not inflate the denominator (WS-M.4.2c).
      // Treasury-controlling votes NEVER take the shortcut: null member facts
      // fail closed at signing (a steward without an active subscription
      // cannot cast a spend ballot), so they must not count in the basis.
      //
      // A PARTICIPATION-DENOMINATED weight model also disqualifies the shortcut,
      // because it is the other half of the ballot gate: `signProposal` refuses a
      // zero-weight ballot, quorum counts DISTINCT RECORDED VOTERS, and under
      // `reputation_bounded` a member with no qualifying contributions resolves
      // to zero — so counting them here makes quorum unreachable no matter how
      // many members vote.  Only the models whose weight can BE zero need the
      // per-member walk; `one_civic_account_one_vote` and `role_based_quorum`
      // resolve `min(1, cap)` with a positive cap, so they keep the fast count.
      const zeroWeightPossible =
        eligibility?.weight !== undefined &&
        WEIGHT_MODELS_THAT_CAN_RESOLVE_ZERO.has(eligibility.weight.model);
      const trivial =
        eligibility === undefined ||
        (!eligibility.treasuryControlling &&
          !zeroWeightPossible &&
          (eligibility.rules.minMembershipDays ?? 0) === 0 &&
          (eligibility.rules.minContributions ?? 0) === 0 &&
          eligibility.rules.requireVerifiedIdentity !== true);
      // The electorate AS OF the freeze instant, on BOTH arms — a count taken
      // live and an instant stamped beside it are two answers to one question.
      if (trivial) return forum.rooms.countEligibleVoters(roomId, eligibility?.asOf);
      const ids = await forum.rooms.listEligibleVoterIds(roomId, eligibility.asOf);
      let eligible = 0;
      for (const userId of ids) {
        // ROUTE-GATE PARITY for treasury-controlling counts (W13): production
        // ballots and delegations require a verified ADULT account, so members
        // who could never reach signProposal must not inflate the basis.
        if (eligibility?.treasuryControlling === true) {
          const user = await identity.store.getUser(userId);
          if (user?.ageBand !== 'adult') continue;
          const inventory = await authMethodInventory(identity, userId);
          if (!hasVerifiedCredential(inventory)) continue;
        }
        const facts = await memberFacts(roomId, userId);
        const verdict = checkVoterEligibility(
          {
            userId,
            membershipDays: facts?.membershipDays ?? null,
            contributionCount: facts?.contributionCount ?? null,
            verifiedIdentity: facts?.verifiedIdentity ?? false,
            // Wallet arms are neutral for the basis: any member could link a
            // sufficiently aged wallet before voting.
            newestWalletAgeDays: Number.MAX_SAFE_INTEGER,
            walletClusterId: null,
            hasDisclosedConflict: false,
            roleClasses: [],
            reputationScore: 0,
            tokenVoteUnits: 0,
            isDesignatedSigner: false,
          },
          {
            rules: eligibility.rules,
            treasuryControlling: eligibility.treasuryControlling,
            recusalRequired: false,
            clustersAlreadyVoted: new Set(),
          },
        );
        if (!verdict.eligible) continue;
        // The weight half of the ballot gate, applied with the SAME resolver
        // `signProposal` uses — a member it would refuse with
        // `zero_voting_weight` cannot record a ballot, and quorum counts
        // recorded ballots, so they are not part of the electorate.
        if (eligibility?.weight !== undefined) {
          const resolved = resolveVotingWeight({
            model: eligibility.weight.model,
            facts: {
              userId,
              membershipDays: facts?.membershipDays ?? null,
              contributionCount: facts?.contributionCount ?? null,
              verifiedIdentity: facts?.verifiedIdentity ?? false,
              newestWalletAgeDays: Number.MAX_SAFE_INTEGER,
              walletClusterId: null,
              hasDisclosedConflict: false,
              roleClasses: [],
              reputationScore: facts?.contributionCount ?? 0,
              tokenVoteUnits: 0,
              isDesignatedSigner: false,
            },
            maxVotingWeightPerAccount: eligibility.weight.maxVotingWeightPerAccount,
            // The gated models are refused wholesale at signing, so a room on
            // one has no voters at all — mirror that rather than inventing a
            // basis for ballots nobody can cast.
            gates: {
              sybilControlsVerified: false,
              antiBriberyMonitoring: false,
              legalReviewPassed: false,
            },
            delegations: [],
          });
          if (!resolved.resolved || decCompare(resolved.weight, 0) <= 0) continue;
        }
        eligible += 1;
      }
      return eligible;
    },
  };
}

/** WS-L.2.5b: LIVE WS-M obligations for the wallet-unlink check (W12) — a
 *  grant recipient must not unlink their LAST active wallet while an
 *  unsettled `user:<id>` grant needs it for the payout binding, and an owner
 *  of in-flight intents keeps the wallet until they settle. */
export function buildTreasuryObligationsPort(services: {
  wallets: TreasuryServices['wallets'];
  grants: TreasuryServices['grants'];
  intents: TreasuryServices['intents'];
}): TreasuryObligationsPort {
  return {
    obligationsForWallet: async (walletAccountId) => {
      const wallet = await services.wallets.getById(walletAccountId);
      if (wallet === null) return [];
      const obligations: ExternalObligation[] = [];
      // Unsettled grants payable to this member block unlinking the LAST
      // active wallet (the payout attach binds to the linked-wallet set).
      const others = (await services.wallets.listByUser(wallet.userId, false)).filter(
        (w) => w.unlinkState === 'active' && w.walletAccountId !== walletAccountId,
      );
      if (others.length === 0) {
        const pending = await services.grants.listUnsettledByRecipient(`user:${wallet.userId}`, 1);
        if (pending.length > 0) {
          obligations.push({
            type: 'pending_grant',
            ref: pending[0]?.grantId ?? 'grant',
            description:
              'An unsettled grant pays this member; keep a linked wallet until it settles.',
          });
        }
      }
      // In-flight intents owned by the member still need a signing wallet.
      const inflight = (await services.intents.listActiveByUser(wallet.userId, 1)).length > 0;
      if (inflight && others.length === 0) {
        obligations.push({
          type: 'pending_payment',
          ref: walletAccountId,
          description: 'A payment intent is still in flight for this account.',
        });
      }
      return obligations;
    },
  };
}

/** The shipped WS-U executor seam (fail-closed; the WS-M production caller). */
export function buildTreasuryExecutorPort(service: GovernanceService): TreasuryExecutorPort {
  return {
    execute: async (roomId, action) => {
      const result = await service.executeTreasuryAction(roomId, {
        category: action.category,
        amount: action.amount,
        asset: action.asset,
        coiDeclared: action.coiDeclared,
        proposedAt: action.proposedAt,
        // The proposal's PINNED pack (WS-M.4.3b): kernel caps evaluate under
        // the rules the spend was voted with, agent binding not required.
        lawPack: action.lawPack ?? null,
      });
      if (!result.ok) return { accepted: false, code: result.code };
      return result.value.accepted
        ? { accepted: true, code: null }
        : { accepted: false, code: result.value.code };
    },
  };
}

/** Community-voted early rotation → a FORCED WS-U election (WS-M.4.3b).
 *
 *  `eligibleVoterCount` is the same soft cross-context membership read the
 *  governance scheduler injects.  A forced rotation opens a real election, so
 *  it must freeze the same turnout electorate a scheduled one does — omitting
 *  it would leave rotation-opened elections with the legacy live-read-at-settle
 *  behaviour this port exists downstream of.
 *
 *  The `asOf` SECOND ARGUMENT is load-bearing and must be threaded, not
 *  dropped.  `scheduleElection` captures the instant it will record as
 *  `opensAt` and passes it here; a callback typed to take only `roomId`
 *  silently discards it and counts live, so a member joining after `opensAt`
 *  but before the query returns lands in `eligibleCount` while
 *  `castElectionVote` refuses them for `joinedAt > opensAt` — a denominator
 *  padded with someone who cannot vote.  A forced rotation is exactly when a
 *  room is in flux, so this is the path least able to afford the gap. */
export function buildStewardElectionPort(
  service: GovernanceService,
  eligibleVoterCount?: (roomId: string, asOf: string) => Promise<number>,
): StewardElectionPort {
  return {
    openElection: async (roomId) => {
      const result = await service.scheduleElection(roomId, {
        force: true,
        ...(eligibleVoterCount ? { eligibleVoterCount } : {}),
      });
      // An already-open election satisfies the rotation intent (idempotent).
      return result.ok || result.code === 'election_open';
    },
  };
}

export interface TreasuryServicesInputs {
  knomosis: KnomosisServices;
  governanceStores: GovernanceStores;
  membership: MembershipFactsPort;
  treasuryExecutor: TreasuryExecutorPort;
  elections: StewardElectionPort;
}

/** Assemble the container from in-memory stores + the given ports. */
export function createInMemoryTreasuryServices(inputs: TreasuryServicesInputs): TreasuryServices {
  const { knomosis } = inputs;
  const rooms = knomosis.rooms;
  const roomMode = knomosis.roomMode;
  if (rooms === null || roomMode === null) {
    throw new Error('Treasury services need the room governance + mode ports wired first');
  }
  const services: TreasuryServices = {
    // WS-M stores (production boot swaps Drizzle adapters in by assignment).
    profiles: new InMemoryGovernanceProfileStore(),
    charters: new InMemoryCharterStore(),
    treasuries: new InMemoryTreasuryStore(),
    reservations: new InMemoryReservationStore(),
    intents: new InMemoryPaymentIntentStore(),
    grants: new InMemoryGrantStore(),
    budgets: new InMemoryActionBudgetStore(),
    delegations: new InMemoryDelegationStore(),
    challenges: new InMemoryChallengeStore(),
    snapshots: new InMemorySnapshotStore(),
    attestations: new InMemoryAttestationStore(),
    // Shipped WS-L/WS-U stores + ports, shared by reference.
    lawPacks: inputs.governanceStores.lawPacks,
    seats: inputs.governanceStores.seats,
    bindings: inputs.governanceStores.bindings,
    models: inputs.governanceStores.models,
    proposals: knomosis.proposals,
    proposalSignatures: knomosis.proposalSignatures,
    wallets: knomosis.wallets,
    actions: knomosis.actions,
    receipts: knomosis.receipts,
    governanceAudit: knomosis.governanceAudit,
    comprehension: knomosis.comprehension,
    compliance: knomosis.compliance,
    regionResolver: knomosis.regionResolver,
    configStore: knomosis.configStore,
    rooms,
    roomMode,
    identityAudit: knomosis.audit,
    // §28.3 DEPLOYMENT-scope expansion gate.  `canExpandTreasury` shipped with
    // zero callers while five sibling comments reasoned about it as a live
    // control; this is the wiring that makes it one.  Unwired, the readiness
    // gate refuses expansion rather than skipping the check.
    // Scoped to the ROOM's own deployment: a divergence on another active
    // deployment describes an expansion that is not this room's.
    // Reads `services.treasuries` AT CALL TIME, never a captured instance: the
    // production boot swaps the Drizzle adapter onto this field by assignment,
    // so a closure over the constructor's in-memory store would answer from the
    // discarded adapter — the same way the AI container's hand-assigned Drizzle
    // stores were silently skipped.
    canExpandDeployment: async (roomId) =>
      canExpandForRoom({ ...knomosis, treasuries: services.treasuries }, roomId),
    // WS-K.2.2a §24.5 — the advisory pass over a newly published proposal.
    // `buildGovernanceAiDeps` was the one wiring builder with no production
    // caller, so `governance-ai.ts` (the whole §24.5 permitted-capability set:
    // plain-language summary, missing required fields, conflict of interest,
    // scam-pattern language) was reachable from nothing.  `tryGet…` rather than
    // `get…`: a deployment with no AI wired keeps full governance and simply
    // gets no advice, which is what "advisory" has to mean.
    governanceAdvisor: async (input) => {
      const ai = tryGetAiGovernanceServices();
      if (ai === null) return;
      const aiDeps = buildGovernanceAiDeps(ai);
      await summarizeProposal(aiDeps, {
        proposalRef: input.proposalRef,
        fields: input.fields,
      });
      // PERSIST what the advisor found.  Both calls return a concrete advisory
      // (proposer-is-recipient, scam-associated language) and this caller used
      // to discard the value, so the advice reached no store, no route, and no
      // steward — "advisory" only means anything when someone can read the
      // advice and knowingly ignore it.
      const advisories = [
        input.recipientRef === null
          ? null
          : await highlightConflictOfInterest(
              aiDeps,
              input.proposalRef,
              input.proposerRef,
              input.recipientRef,
            ),
        await detectScamPatterns(aiDeps, input.proposalRef, input.text),
      ];
      for (const advisory of advisories) {
        if (advisory !== null) await ai.governanceAdvisories.put(advisory);
      }
    },
    masterSecret: knomosis.masterSecret,
    contractVerifier: knomosis.contractTypedDataVerifier,
    membership: inputs.membership,
    treasuryExecutor: inputs.treasuryExecutor,
    elections: inputs.elections,
    config: knomosis.config,
    wsmConfig: knomosis.config,
    wsmProposalConfig: knomosis.config,
    reconciliationGraceMs: () => knomosis.config().reconciliationIntervalMs,
    alert: knomosis.alert,
    now: knomosis.now,
    uuid: knomosis.uuid,
    // Non-reversible actor ref for the WS-M.4.3c hash chain (domain-separated
    // so it never collides with any other accountRef use). The chain hashes
    // THIS, never the erasable actor_user_id, so erasure never breaks verify.
    opaqueRef: (id: string) => accountRef(knomosis.masterSecret, `governance-audit:${id}`),
  };
  return services;
}

let singleton: TreasuryServices | null = null;

export function setTreasuryServices(services: TreasuryServices): void {
  singleton = services;
}

/** Financial service: throws when unconfigured (never a silent fallback). */
export function getTreasuryServices(): TreasuryServices {
  if (singleton === null) {
    throw new Error('Treasury services not configured — call setTreasuryServices() at startup');
  }
  return singleton;
}

export function treasuryServicesConfigured(): boolean {
  return singleton !== null;
}

export function resetTreasuryServicesForTests(): void {
  singleton = null;
}
