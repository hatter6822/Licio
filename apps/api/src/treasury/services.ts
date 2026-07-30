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

import type { GovernanceAdvisory } from '@licio/ai-governance';
import {
  detectScamPatterns,
  highlightConflictOfInterest,
  summarizeProposal,
} from '../ai-governance/governance-ai.js';
import { tryGetAiGovernanceServices } from '../ai-governance/services.js';
import { buildGovernanceAiDeps } from '../ai-governance/wiring.js';
import { complianceServicesConfigured, getComplianceServices } from '../compliance/services.js';
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
import {
  BASIS_EXCLUSIONS,
  ballotVerdict,
  buildVoterFacts,
  DEFAULT_ELIGIBILITY_RULES,
  deriveMemberFacts,
} from './ballot-predicate.js';
import { type ElectorateBasisStore, InMemoryElectorateBasisStore } from './electorate-basis.js';
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
  /**
   * The electorate snapshot, resolved LAZILY at each call.
   *
   * A thunk rather than the store, because the production boot constructs this port
   * BEFORE it assigns the Drizzle adapters over the container — so a port that captured
   * the store eagerly would capture the IN-MEMORY one and quietly serve it in production,
   * the same way the AI container's hand-assigned Drizzle stores were once skipped.
   *
   * Omitted ⇒ an in-memory snapshot over this port's own readers, which is what every
   * existing test harness gets without changing a line.
   */
  basis?: () => ElectorateBasisStore,
): MembershipFactsPort {
  const memberFacts = async (roomId: string, userId: string, asOf?: string) => {
    const subscription = await forum.rooms.getSubscription(roomId, userId);
    const auth = await identity.store.getAuth(userId);
    // EVERY FACT AT ONE INSTANT.  `asOf` is the instant the electorate was frozen;
    // reading `now()` for the age while the basis had been counted earlier is what let a
    // member cross the tenure threshold mid-window and vote against a denominator they
    // were never in.
    //
    // The DERIVATION itself lives in `ballot-predicate.ts` and is shared with the basis
    // fold, which reads the same fields out of one snapshot instead of three stores.
    // Written twice, the two came to disagree about the same member — which is the
    // defect this area keeps producing.
    return deriveMemberFacts(
      {
        subscribed: subscription !== null && subscription.status === 'active',
        joinedAt: subscription?.joinedAt ?? null,
        requestedAt: subscription?.requestedAt ?? null,
        emailVerified: auth?.emailVerified === true,
        emailVerifiedAt: auth?.emailVerifiedAt ?? null,
        contributionCount: await knomosis.governanceAudit.countQualifyingByRoomActor(
          roomId,
          userId,
          asOf,
        ),
      },
      asOf === undefined ? knomosis.now() : Date.parse(asOf),
      asOf,
    );
  };

  /** The snapshot source: the injected one, or an in-memory fold over these readers. */
  const resolveBasis: () => ElectorateBasisStore =
    basis ??
    (() =>
      new InMemoryElectorateBasisStore({
        roster: (roomId, asOf) => forum.rooms.listEligibleVoterIds(roomId, asOf),
        subscription: async (roomId, userId) => {
          const sub = await forum.rooms.getSubscription(roomId, userId);
          return sub === null
            ? null
            : { status: sub.status, joinedAt: sub.joinedAt, requestedAt: sub.requestedAt };
        },
        account: async (userId) => {
          const user = await identity.store.getUser(userId);
          return user === null ? null : { accountState: user.accountState, ageBand: user.ageBand };
        },
        auth: async (userId) => {
          const auth = await identity.store.getAuth(userId);
          return auth === null
            ? null
            : { emailVerified: auth.emailVerified, emailVerifiedAt: auth.emailVerifiedAt };
        },
        hasVerifiedCredential: async (userId) =>
          hasVerifiedCredential(await authMethodInventory(identity, userId)),
        // The SAME three reads `checkGovernanceEligibility` makes, and the same shapes
        // the statement encodes — including the suppressed-lawful-access exclusion, so a
        // refusal cannot reveal what counsel has not permitted a member to be told.
        kycVerified: async (userId) => {
          if (!complianceServicesConfigured()) return false;
          const c = getComplianceServices();
          return (await c.kycLevel(userId)) === 'kyc_partner';
        },
        hasComplianceHold: async (userId) => {
          if (!complianceServicesConfigured()) return false;
          const c = getComplianceServices();
          const suppressed = await c.lawfulAccess.unnotifiedCaseIdsForSubject(userId);
          return (
            (await c.cases.countOpenByRisk(userId, 'user', ['high', 'critical'], suppressed)) > 0
          );
        },
        hasHighRiskWallet: async (userId) =>
          (await knomosis.wallets.listByUser(userId, false)).some((w) => w.riskState === 'high'),
        contributionCount: (roomId, userId, asOf) =>
          knomosis.governanceAudit.countQualifyingByRoomActor(roomId, userId, asOf),
        now: () => knomosis.now(),
      }));
  const basisStore = resolveBasis;

  const port: MembershipFactsPort = {
    memberFacts,
    eligibleMemberCount: async (roomId, eligibility) => {
      // NO FAST PATH.  There used to be one: with trivial rules and no
      // participation-denominated model, the basis returned a raw
      // `countEligibleVoters` instead of walking, because the walk cost 4N–9N round
      // trips and the rules could not refuse anyone.
      //
      // Two things ended it. The walk is now ONE statement, so the shortcut saves a
      // fraction of one query rather than a fan-out. And the account and compliance
      // gates below apply to EVERY ballot, not just the ones with rules — a raw count
      // cannot express "adult, verified, KYC-standing, no hold, no flagged wallet", so
      // taking it would count members the ballot gate refuses and inflate the quorum bar
      // by exactly the population that cannot turn up. A shortcut that is only sound
      // when nothing can refuse anyone stopped being sound the moment something always
      // can.
      //
      // With no eligibility spec at all the pack's rules are the permissive defaults —
      // but the route gates still apply, because they are the route's, not the pack's.
      const spec = eligibility ?? {
        rules: DEFAULT_ELIGIBILITY_RULES,
        treasuryControlling: false,
      };
      // ONE SNAPSHOT, not a fan-out.  This walked the roster and read three stores per
      // member (seven on a treasury-controlling vote), each in its own snapshot — so the
      // instant it stamped was not the instant its count described, and a member who left
      // mid-walk dropped out of a count already stamped.  `snapshot` is one statement:
      // every fact below describes one state, and its `asOf` IS that state's instant.
      const snap = await basisStore().snapshot(roomId, spec.asOf);
      let eligible = 0;
      for (const row of snap.members) {
        const userId = row.userId;
        // ROUTE-GATE PARITY for treasury-controlling counts (W13): production
        // ballots and delegations require a verified ADULT account, so members
        // who could never reach signProposal must not inflate the basis.
        // ROUTE-GATE PARITY, UNCONDITIONALLY.
        //
        // `/sign` applies authMiddleware + requireVerifiedAccount + requireAdult +
        // requireGovernanceEligibility to EVERY ballot, not only a treasury-controlling
        // one. This mirrored the first two and only on the treasury arm, and the third
        // not at all — so on an ordinary proposal the denominator counted teens,
        // unverified accounts, suspended accounts, members with no KYC standing, members
        // under a compliance hold and members whose wallet is flagged high-risk, none of
        // whom can record a ballot. Every one of those inflates the quorum bar: the vote
        // needs turnout from a population that is not allowed to turn up.
        //
        // A `restricted` account DOES count: `accountMayHoldSession` admits it, and the
        // restriction blocks public contribution rather than self-service governance.
        // A KNOWN state that cannot hold a session is a refusal; an UNKNOWN one is
        // admitted, which is this port's standing discipline for a fact it cannot
        // establish (`memberSince`, `emailVerifiedAt`) and the safe direction besides —
        // a wider denominator only ever makes quorum harder. `account_state` is NOT NULL
        // with a default, so null here means no user row at all, and such a member is
        // already refused by the age gate below (`age_band_if_known` would be null too).
        if (
          row.accountState !== null &&
          row.accountState !== 'active' &&
          row.accountState !== 'restricted'
        ) {
          continue;
        }
        // `requireAdult()` denies unless the band IS adult, so an unknown age is a
        // refusal here too — `age_band_if_known` is nullable by design (a raw date of
        // birth is never stored), which makes "unknown" a real production state and a
        // real refusal, not a gap.
        if (row.ageBand !== 'adult') continue;
        // `requireVerifiedAccount()` — a verified email, a passkey, or a wallet
        // credential; any one of the three.
        if (!row.hasVerifiedCredential) continue;
        // The three `checkGovernanceEligibility` legs, FROZEN at the measurement instant
        // per the maintainer's decision: a member who loses standing mid-window stays in
        // the denominator and is refused a ballot, which shrinks turnout without
        // shrinking the denominator. That direction only ever makes quorum HARDER, which
        // is the safe way to be wrong about an electorate.
        if (!row.kycVerified) continue;
        if (row.hasComplianceHold) continue;
        if (row.hasHighRiskWallet) continue;
        // The SAME derivation `memberFacts` uses, over the snapshot's row rather than
        // three live reads — one spelling, so the basis and the ballot gate cannot come
        // to disagree about a member.
        const facts = deriveMemberFacts(row, Date.parse(snap.asOf), spec.asOf);
        // ONE PREDICATE, the same call `signProposal` makes.  The basis used to build
        // `VoterFacts` twice in this loop — `reputationScore: 0` for eligibility and
        // `contributionCount ?? 0` for the weight — so the two halves of one answer
        // disagreed about the same member.  What the basis deliberately does not mirror
        // is now NAMED in `BASIS_EXCLUSIONS` rather than hard-coded here.
        const verdict = ballotVerdict(
          buildVoterFacts({
            userId,
            facts: facts ?? null,
            ...BASIS_EXCLUSIONS,
            // FROM THE PINNED PACK, exactly as the ballot gate reads it.  Hard-coding
            // false here made `resolveVotingWeight` refuse every member under
            // `multisig_steward` — a basis of ZERO, and quorum unreachable however many
            // signers cast a ballot the gate happily accepted.
            isDesignatedSigner: spec.weight?.signers?.includes(userId) ?? false,
          }),
          {
            rules: spec.rules,
            treasuryControlling: spec.treasuryControlling,
            recusalRequired: false,
            weight: spec.weight ?? {
              model: 'one_civic_account_one_vote',
              maxVotingWeightPerAccount: 1,
            },
          },
        );
        if (!verdict.admitted) continue;
        eligible += 1;
      }
      return eligible;
    },
    measureEligibleMembers: async (roomId, eligibility) => {
      // THE INSTANT COMES FROM THE MEASUREMENT, for the reason the port documents.
      //
      // `measureEligibleVoters` is one statement returning both, so the fast count
      // is EXACT.  It also serves as the roster instant for the per-member walk: a
      // pack whose weight can resolve to zero needs the walk, and taking its `asOf`
      // from that first read removes the join direction outright — nobody who joined
      // after it is in the roster the walk enumerates OR inside the ballot cutoff.
      // A member who leaves mid-walk can still lose their facts read and drop out of
      // the count; closing that needs the whole walk under one database snapshot,
      // which this port boundary does not offer (tracked in `docs/treasury/README.md`).
      const measured = await forum.rooms.measureEligibleVoters(roomId);
      if (eligibility === undefined) return measured;
      const count = await port.eligibleMemberCount(roomId, {
        ...eligibility,
        asOf: measured.asOf,
      });
      return { count, asOf: measured.asOf };
    },
  };
  return port;
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
  measureElectorate?: (roomId: string) => Promise<{ count: number; asOf: string }>,
): StewardElectionPort {
  return {
    openElection: async (roomId) => {
      const result = await service.scheduleElection(roomId, {
        force: true,
        ...(measureElectorate ? { measureElectorate } : {}),
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
      // PERSIST what the advisor found.  Both calls return a concrete advisory
      // (proposer-is-recipient, scam-associated language) and this caller used
      // to discard the value, so the advice reached no store, no route, and no
      // steward — "advisory" only means anything when someone can read the
      // advice and knowingly ignore it.
      // PERSIST EACH FINDING AS IT IS PRODUCED.  Building the array first meant
      // one rejected check discarded the other's already-computed advisory: the
      // COI flag would be gone while its `AIOutputRecord` remained, so the audit
      // trail showed an assessment that no steward could read.  The outer path
      // catches and returns success — advice is not a precondition of governance
      // — which is exactly why a lost advisory here is silent.
      //
      // Each check is also isolated from the other: a scam-marker list that is
      // temporarily unavailable must not cost the conflict-of-interest finding,
      // and vice versa.  They answer different questions and neither is the
      // other's precondition.
      //
      // THE SUMMARIZER IS ONE OF THEM.  It ran unguarded three lines above this
      // loop, so its failure cost BOTH advisories — the identical loss the
      // isolation was added to prevent, from the same function, and the summary
      // is a §24.5 capability of its own with its own per-capability guard and its
      // own store.  It reaches this list rather than a `try` of its own so there
      // is one place where "a capability failed" is handled, and no fourth
      // capability can be added outside it.  (`summarizeProposal` is now also
      // total with respect to its input, so the attacker-triggerable throw is
      // gone at the source; this is the containment, not the fix.)
      const checks: Array<() => Promise<GovernanceAdvisory | null>> = [
        async () => {
          await summarizeProposal(aiDeps, {
            proposalRef: input.proposalRef,
            fields: input.fields,
          });
          return null; // the summary has its own store; nothing to add here
        },
        ...(input.recipientRef === null
          ? []
          : [
              () =>
                highlightConflictOfInterest(
                  aiDeps,
                  input.proposalRef,
                  input.proposerRef,
                  input.recipientRef as string,
                ),
            ]),
        () => detectScamPatterns(aiDeps, input.proposalRef, input.text),
      ];
      for (const check of checks) {
        try {
          const advisory = await check();
          if (advisory !== null) await ai.governanceAdvisories.put(advisory);
        } catch (error) {
          knomosis.alert?.('governance.advisory.check_failed', {
            proposal_id: input.proposalRef,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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
