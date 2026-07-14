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

import type { ForumServices } from '../forum/services.js';
import type { GovernanceService } from '../governance/service.js';
import type { GovernanceStores } from '../governance/stores.js';
import type { IdentityServices } from '../identity/services.js';
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
  return {
    memberFacts: async (roomId, userId) => {
      const subscription = await forum.rooms.getSubscription(roomId, userId);
      if (subscription === null || subscription.status !== 'active') return null;
      const auth = await identity.store.getAuth(userId);
      const membershipDays = Math.floor(
        (knomosis.now() - Date.parse(subscription.requestedAt)) / 86_400_000,
      );
      return {
        membershipDays: Number.isFinite(membershipDays) ? Math.max(0, membershipDays) : null,
        contributionCount: await knomosis.governanceAudit.countQualifyingByRoomActor(
          roomId,
          userId,
        ),
        verifiedIdentity: auth?.emailVerified === true,
      };
    },
    eligibleMemberCount: async (roomId) => forum.rooms.countEligibleVoters(roomId),
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
      });
      if (!result.ok) return { accepted: false, code: result.code };
      return result.value.accepted
        ? { accepted: true, code: null }
        : { accepted: false, code: result.value.code };
    },
  };
}

/** Community-voted early rotation → a FORCED WS-U election (WS-M.4.3b). */
export function buildStewardElectionPort(service: GovernanceService): StewardElectionPort {
  return {
    openElection: async (roomId) => {
      const result = await service.scheduleElection(roomId, { force: true });
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
  return {
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
  };
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
