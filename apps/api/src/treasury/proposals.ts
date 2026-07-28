// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.4 — the PRODUCTION governance-proposal lifecycle over the shipped
// `governance_proposal` table (production rows carry simulationMode=false; the
// WS-L.4 simulated lifecycle keeps its own surface untouched):
//
//   create   — draft validation (WS-M.4.1b) + fail-closed preflight
//              (WS-M.4.1c: type allowlist, role permission, the WS-M.1.2d
//              prohibited-target classifier, cap headroom incl. reservations,
//              reconciled-balance sufficiency, recipient sanctions, action
//              budget) + law-pack version PINNING (WS-M.1.3d) + publication
//              into a deliberation window (WS-M.4.2a).
//   sign     — wallet-signature voting (WS-M.2.3b-1): the SAME WS-L EIP-712
//              verifiers, server-recomputed typed-data hash, per-proposal
//              single-use nonce, the §17.5 eligibility gate before the weight
//              resolver, and the CAPPED weight snapshot recorded with the
//              signature (WS-M.4.2c).
//   settle   — the deadline sweep (WS-M.4.2d): deliberation→open, then the
//              exact-decimal kernel tally over recorded snapshots at the
//              voting deadline; a pass starts the challenge window + timelock
//              and RESERVES the spend (WS-M.2.3a-1); pass/fail is CAS-settled
//              so two sweeps can never double-close.
//   challenge— WS-M.4.3a: typed challenges during the window; unresolved
//              challenges block execution; legal/capture escalate to platform.
//   execute  — WS-M.4.3b: an EXPLICIT steward trigger that re-checks every
//              prerequisite, claims the proposal (the shipped CAS), routes
//              treasury categories through the shipped fail-closed
//              `executeTreasuryAction` (closing the WS-U residual), consumes
//              the reservation atomically, and finalizes.  Expired execution
//              windows release the reservation (`expired`).

import { createHash } from 'node:crypto';
import {
  checkVoterEligibility,
  type EligibilityRules,
  type LawPack,
  resolveVotingWeight,
  tallyProposalVotes,
  type VoterFacts,
  type WeightResolution,
} from '@licio/governance';
import {
  charterSectionsSchema,
  type GovernanceMode,
  type ProductionProposalCreate,
  type ProposalTallyWire,
  type ProposalType,
} from '@licio/shared';
import type { PwattConfigStore } from '../events/stores.js';
import { hashFinancialWalletAddress } from '../identity/siwe.js';
import { killSwitchDecision } from '../knomosis/killswitch.js';
import { pinnedDeployment } from '../knomosis/pin.js';
import type { CompliancePort, RegionResolverPort } from '../knomosis/ports.js';
import { buildEip712Domain, type RoomGovernancePort } from '../knomosis/preflight.js';
import type { RoomModePort } from '../knomosis/readiness.js';
import { type ContractTypedDataVerifier, verifyActionSignature } from '../knomosis/signatures.js';
import type {
  FinancialWalletStore,
  GovernanceProposalRecord,
  GovernanceProposalStore,
  GovernanceSignatureRecord,
  GovernanceSignatureStore,
} from '../knomosis/stores.js';
import { isUniqueViolation } from '../lib/pg-errors.js';
import { appendChainedAudit } from './audit-chain.js';
import { chargeRoomActionBudget, NO_BUDGET_RULES, refundActionBudget } from './budgets.js';
import { readabilityProblems } from './charter.js';
import { delegatorsAlreadyConsumed, incomingDelegationsFor } from './delegations.js';
import { createGrantFromProposal, type GrantDeps, hasValidMilestonePlan } from './grants.js';
import {
  activeLawPack,
  adoptLawPack,
  type LawPackDeps,
  lawPackRealAssetFailure,
} from './law-packs.js';
import { assertGovernanceWritable, type TreasuryGovernanceError, tgErr } from './profile.js';
import { classifyProposalTarget } from './prohibited-targets.js';
import {
  categoryHeadroom,
  consumeReservation,
  releaseReservation,
  reserveForProposal,
} from './reservations.js';
import type {
  ActionBudgetStore,
  ChallengeRecord,
  ChallengeStore,
  CharterStore,
  DelegationStore,
  ReservationStore,
} from './stores.js';

/** WS-M facts about a member the eligibility gate folds over (wired to the
 *  forum/identity stores at boot; null facts fail closed for treasury votes). */
export interface MembershipFactsPort {
  memberFacts(
    roomId: string,
    userId: string,
  ): Promise<{
    membershipDays: number | null;
    contributionCount: number | null;
    verifiedIdentity: boolean;
  } | null>;
  /** The quorum-basis population.  With `eligibility` set, the SAME law-pack
   *  predicate that gates ballots filters the denominator — otherwise members
   *  who can never vote would inflate the basis and starve quorum (WS-M.4.2c). */
  eligibleMemberCount(
    roomId: string,
    eligibility?: { rules: EligibilityRules; treasuryControlling: boolean },
  ): Promise<number>;
}

/** The shipped WS-U executor seam (GovernanceService.executeTreasuryAction). */
export interface TreasuryExecutorPort {
  execute(
    roomId: string,
    action: {
      category: string;
      amount: string;
      asset: string | null;
      coiDeclared: boolean;
      proposedAt: string;
      /** The proposal's PINNED law-pack: the kernel evaluates the voted spend
       *  under the rules it was authorized with, and a community-passed
       *  execution needs no AI-agent binding (null falls back to the agent
       *  binding's pack — the autonomous-agent path). */
      lawPack?: LawPack | null;
    },
  ): Promise<{ accepted: boolean; code: string | null }>;
}

/** WS-U election seam for `steward_rotation` execution (WS-M.4.3b). */
export interface StewardElectionPort {
  openElection(roomId: string): Promise<boolean>;
}

export interface ProposalDeps extends LawPackDeps, GrantDeps {
  proposals: GovernanceProposalStore;
  proposalSignatures: GovernanceSignatureStore;
  challenges: ChallengeStore;
  delegations: DelegationStore;
  budgets: ActionBudgetStore;
  reservations: ReservationStore;
  charters: CharterStore;
  wallets: FinancialWalletStore;
  rooms: RoomGovernancePort;
  roomMode: RoomModePort;
  membership: MembershipFactsPort;
  treasuryExecutor: TreasuryExecutorPort;
  elections: StewardElectionPort;
  compliance: CompliancePort;
  regionResolver: RegionResolverPort;
  configStore: PwattConfigStore;
  masterSecret: string;
  contractVerifier?: ContractTypedDataVerifier | undefined;
  wsmProposalConfig: () => {
    wsmDeliberationSeconds: number;
    wsmVotingSeconds: number;
    wsmChallengeWindowSeconds: number;
    wsmExecutionWindowSeconds: number;
  };
  /** Operational alert sink (the container provides it; optional for tests). */
  alert?: (event: string, meta: Record<string, unknown>) => void;
}

/** Real-asset modes where production proposals run (sim rooms use WS-L.4). */
const PRODUCTION_MODES: ReadonlySet<GovernanceMode> = new Set([
  'testnet',
  'capped_production',
  'mature_production',
]);

/** Spend category per spend-bearing proposal type. */
const SPEND_CATEGORY: Readonly<Partial<Record<ProposalType, string>>> = {
  capped_grant: 'grant',
  bounty: 'bounty',
};

/** Proposal types only the elected steward (or platform) may open. */
const STEWARD_ONLY_TYPES: ReadonlySet<ProposalType> = new Set([
  'law_pack_upgrade',
  'treasury_policy_update',
  'steward_rotation',
]);

/** Treasury-CONTROLLING proposals: spend-bearing categories plus the types
 *  that rewrite the treasury's rules — the SINGLE predicate `signProposal`
 *  and the quorum basis share, so a member the ballot gate would refuse can
 *  never inflate the denominator (W14). */
export function isTreasuryControlling(proposal: {
  category?: string | null | undefined;
  proposalType: string;
}): boolean {
  return (
    (proposal.category !== null && proposal.category !== undefined) ||
    proposal.proposalType === 'law_pack_upgrade' ||
    proposal.proposalType === 'treasury_policy_update'
  );
}

/** Deterministic proposal id from the client idempotency scope, so a replayed
 *  create maps to the SAME row (the primary key is the idempotency record). */
export function deterministicProposalId(roomId: string, userId: string, key: string): string {
  const digest = createHash('sha256').update(`${roomId}\n${userId}\n${key}`, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4 shape
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const wireTally = (tally: ReturnType<typeof tallyProposalVotes>): ProposalTallyWire => ({
  outcome: tally.outcome,
  quorum_met: tally.quorumMet,
  approve: tally.approve,
  reject: tally.reject,
  abstain: tally.abstain,
  distinct_voters: tally.distinctVoters,
  turnout: tally.turnout,
});

/** Recorded votes (purpose=vote) → the pure tally input. */
function recordedVotes(signatures: readonly GovernanceSignatureRecord[]) {
  return signatures
    .filter(
      (s) =>
        (s.purpose ?? 'vote') === 'vote' &&
        s.choice !== undefined &&
        s.choice !== null &&
        // Only WEIGHT-RESOLVED ballots tally: the generic WS-L submit path
        // records a durable ledger row (WS-L.3.2a) with a null snapshot —
        // it never passed the WS-M eligibility/weight gate, so it must not
        // count as a voter or shift quorum (PR #144 W8).
        s.weightSnapshot !== null &&
        s.weightSnapshot !== undefined,
    )
    .map((s) => ({
      voterUserId: s.userId,
      choice: s.choice as 'approve' | 'reject' | 'abstain',
      weightSnapshot: s.weightSnapshot ?? '0',
    }));
}

async function tallyFor(
  deps: ProposalDeps,
  proposal: GovernanceProposalRecord,
  pack: LawPack,
  deadlinePassed: boolean,
) {
  const signatures = await deps.proposalSignatures.listByProposal(proposal.proposalId);
  const quorum = pack.quorumRules?.[proposal.proposalType] ?? {
    basis: 'eligible_voters' as const,
    minFraction: 0.2,
  };
  const threshold = pack.thresholdRules?.[proposal.proposalType] ?? {
    minAffirmativeFraction: 0.5,
  };
  // The `role_class` basis measures quorum over the pack's DESIGNATED role
  // class (the multisig signer set — the only pack-defined role membership):
  // the population is the signers and only signer ballots count toward
  // showing up.  Threshold arithmetic still uses every recorded vote.
  if (quorum.basis === 'role_class') {
    const signers = new Set(pack.multisig?.signers ?? []);
    const votes = recordedVotes(signatures);
    const signerVoters = new Set(
      votes.filter((v) => signers.has(v.voterUserId)).map((v) => v.voterUserId),
    );
    return tallyProposalVotes(
      votes,
      { quorum, threshold },
      {
        eligibleCount: signers.size,
        deadlinePassed,
        quorumParticipants: signerVoters.size,
      },
    );
  }
  const eligibleCount = await deps.membership.eligibleMemberCount(proposal.roomId, {
    rules: pack.eligibility ?? {
      minMembershipDays: 0,
      minContributions: 0,
      requireVerifiedIdentity: false,
      newWalletCoolingOffDays: 0,
    },
    treasuryControlling: isTreasuryControlling(proposal),
  });
  return tallyProposalVotes(
    recordedVotes(signatures),
    { quorum, threshold },
    {
      eligibleCount,
      deadlinePassed,
    },
  );
}

// ---------------------------------------------------------------------------
// Create + publish (WS-M.4.1a/b/c + 4.2a)
// ---------------------------------------------------------------------------

export async function createProductionProposal(
  deps: ProposalDeps,
  input: { roomId: string; userId: string; create: ProductionProposalCreate },
): Promise<TreasuryGovernanceError | { ok: true; proposal: GovernanceProposalRecord }> {
  // AUTHORIZATION first (checked on every request, retry or not) — and BEFORE the
  // mint-only gates, so a non-member never learns a room is frozen/paused.
  if (!(await deps.rooms.isMember(input.roomId, input.userId))) {
    return tgErr(403, 'not_member', 'Only room members can open proposals.');
  }
  const proposalType = input.create.proposal_type as ProposalType;
  if (STEWARD_ONLY_TYPES.has(proposalType)) {
    if (!(await deps.rooms.isSteward(input.roomId, input.userId))) {
      return tgErr(403, 'steward_required', 'This proposal type requires a room steward.');
    }
  }

  // REPLAY before the mint-only gates.  The deterministic id from (room, user,
  // key) IS the idempotency record, so a lost-response retry must return the
  // stored proposal even if a freeze/pause landed or the law-pack changed since —
  // those gates decide whether a NEW proposal may be minted, and this one already
  // exists.  (The sibling `createPaymentIntent` puts idempotency first, same reason.)
  const proposalId = deterministicProposalId(
    input.roomId,
    input.userId,
    input.create.idempotency_key,
  );
  const existing = await deps.proposals.getById(proposalId);
  if (existing !== null) return { ok: true, proposal: existing };

  // GATES — may a NEW proposal be minted?
  const guard = await assertGovernanceWritable(deps, input.roomId, 'proposals');
  if (guard !== null) return guard;
  const mode = await deps.roomMode.currentMode(input.roomId);
  if (mode === null) return tgErr(404, 'not_found', 'Resource not found');
  if (!PRODUCTION_MODES.has(mode)) {
    return tgErr(
      409,
      'mode_invalid',
      'Production proposals require a real-asset governance mode (simulated rooms practice via the simulation surface).',
    );
  }
  // The room's ACTIVE law-pack is pinned onto the proposal (WS-M.1.3d).
  const active = await activeLawPack(deps, input.roomId);
  if (active === null) {
    return tgErr(409, 'no_law_pack', 'The room has no adopted law-pack.');
  }
  if (!active.pack.allowedProposalTypes.includes(proposalType)) {
    return tgErr(409, 'type_not_allowed', `"${proposalType}" is not allowed by the law-pack.`);
  }

  // Draft completeness (WS-M.4.1b): spend fields all-or-none, category coherent.
  const spendCategory = SPEND_CATEGORY[proposalType] ?? null;
  if (spendCategory !== null) {
    if (
      input.create.requested_amount === null ||
      input.create.asset === null ||
      input.create.recipient_ref === null
    ) {
      return tgErr(400, 'draft_incomplete', 'Spend proposals need amount, asset, and recipient.');
    }
    if (
      input.create.conflict_disclosures === null ||
      input.create.conflict_disclosures.trim() === ''
    ) {
      return tgErr(
        400,
        'coi_required',
        'Spend proposals require a conflict-of-interest disclosure.',
      );
    }
    if (input.create.category !== null && input.create.category !== spendCategory) {
      return tgErr(400, 'category_mismatch', `"${proposalType}" spends from "${spendCategory}".`);
    }
    // The milestone SCHEDULE is part of the voted authorization: validate it
    // at publication so a malformed plan never burns a deliberation/voting
    // cycle only to die at execution (execution re-checks regardless) (W15).
    if (
      !hasValidMilestonePlan({
        requestedAmount: input.create.requested_amount,
        asset: input.create.asset,
        requestedAction: input.create.requested_action,
      })
    ) {
      return tgErr(400, 'milestones_invalid', 'The milestone schedule is malformed.');
    }
  } else if (
    input.create.requested_amount !== null ||
    input.create.asset !== null ||
    // A recipient on a NON-spend proposal is a recusal weapon: `signProposal`
    // treats a matching `recipientRef` as a conflicted recipient, so naming
    // `user:<member>` on a policy/charter proposal would disenfranchise that
    // member (and their delegated unit) from a vote with no recipient (W15).
    input.create.recipient_ref !== null
  ) {
    return tgErr(400, 'draft_invalid', 'This proposal type carries no spend fields.');
  }

  // Prohibited-target classifier (WS-M.1.2d, fail-closed).
  const target = classifyProposalTarget(proposalType, input.create.requested_action);
  if (!target.allowed) return tgErr(422, target.code, target.reason);

  // A law-pack upgrade must target a PUBLISHED pack in THIS room: a missing/
  // foreign/unpublished id would deliberate, pass, and only then die at
  // execution — a wasted governance cycle in a real-asset room.  Real-asset
  // completeness is checked here too (execution re-checks regardless).
  if (proposalType === 'law_pack_upgrade' || proposalType === 'treasury_policy_update') {
    const targetPackId = input.create.requested_action['law_pack_id'];
    const targetRecord =
      typeof targetPackId === 'string' ? await deps.lawPacks.get(targetPackId) : null;
    if (
      targetRecord === null ||
      targetRecord.roomId !== input.roomId ||
      targetRecord.published !== true
    ) {
      return tgErr(
        400,
        'law_pack_target_invalid',
        'The upgrade must target a published law-pack of this room.',
      );
    }
    // The FULL real-asset bar including the live fixture re-run (W11): a
    // fixture-less target would deliberate, pass, and die at adoption.
    const targetFailure = lawPackRealAssetFailure(targetRecord);
    if (targetFailure !== null) return targetFailure;
  }

  // A charter update carries its FULL proposed sections: validate them at
  // publication so a malformed draft can never consume a deliberation/voting
  // cycle only to fail inside `createCharterVersion()` at execution.
  if (proposalType === 'charter_update') {
    const sections = charterSectionsSchema.safeParse(input.create.requested_action['sections']);
    if (!sections.success) {
      return tgErr(
        400,
        'charter_sections_invalid',
        'A charter update must carry the complete valid sections.',
      );
    }
    const readability = readabilityProblems(sections.data);
    if (readability.length > 0) {
      return tgErr(400, 'charter_sections_invalid', readability[0] ?? 'Sections are unreadable.');
    }
  }

  // Spend preflight (WS-M.4.1c): headroom incl. reservations + reconciled funds.
  if (spendCategory !== null && input.create.requested_amount !== null) {
    const treasury = await deps.treasuries.getByRoom(input.roomId);
    if (treasury === null) return tgErr(409, 'no_treasury', 'The room has no treasury.');
    const headroom = await categoryHeadroom(
      deps,
      treasury.treasuryId,
      spendCategory,
      active.pack.treasury,
    );
    if (headroom === null) {
      return tgErr(409, 'no_cap_configured', `No spend cap for "${spendCategory}".`);
    }
    const { decCompare } = await import('@licio/governance');
    // Per-ACTION cap preflight: a request above `perActionMax` can never be
    // reserved, so publishing it would only burn deliberation/voting time
    // before `reserveForProposal()` blocks it at approval.  Reject up front.
    const actionCap = active.pack.treasury.caps.find((c) => c.category === spendCategory);
    if (actionCap !== undefined) {
      const perAction =
        typeof actionCap.perActionMax === 'number'
          ? String(actionCap.perActionMax)
          : actionCap.perActionMax;
      if (decCompare(input.create.requested_amount, perAction) > 0) {
        return tgErr(
          409,
          'per_action_cap_exceeded',
          `Requested ${input.create.requested_amount} exceeds the per-action cap ${perAction}.`,
        );
      }
    }
    if (decCompare(input.create.requested_amount, headroom.headroom) > 0) {
      return tgErr(
        409,
        'insufficient_headroom',
        `Requested ${input.create.requested_amount} exceeds the free headroom ${headroom.headroom}.`,
      );
    }
    // Fail-closed funds check: only a CURRENTLY SYNCED balance can promise
    // money — a pending/divergent treasury keeps its LAST snapshot for the
    // dashboard, but new spend authorizations against stale numbers are
    // refused until reconciliation clears (WS-M.5.2a).
    if (treasury.reconciliationState !== 'synced') {
      return tgErr(
        409,
        'treasury_not_synced',
        'The treasury is not reconciled; new spend proposals are paused.',
      );
    }
    const balance = treasury.balanceSnapshot?.[input.create.asset ?? ''] ?? null;
    if (balance === null) {
      return tgErr(409, 'balance_unreconciled', 'The treasury balance is not reconciled yet.');
    }
    // Liquidity = reconciled balance MINUS active reservations MINUS the
    // consumed-but-UNPAID grant obligations in this asset: an executed grant's
    // reservation moves to `consumed` while its milestone payouts are still
    // pending, yet the cash is still in the reconciled balance — without the
    // encumbrance the same funds could back a second spend (WS-M.2.3a-1).
    const { decSum } = await import('@licio/governance');
    const reservedRows = await deps.reservations.listActiveByTreasuryAsset(
      treasury.treasuryId,
      input.create.asset ?? '',
    );
    const alreadyReserved = decSum(reservedRows.map((r) => r.amount));
    const obligationParts: string[] = [];
    // EVERY unsettled grant, via keyset pages — a fixed newest-N slice would
    // let older outstanding obligations slip out of the liquidity math (W9).
    let grantCursor: string | null = null;
    for (;;) {
      const page = await deps.grants.listUnsettledByTreasury(treasury.treasuryId, 500, grantCursor);
      for (const grant of page) {
        if (grant.asset !== input.create.asset) continue;
        // Outstanding = the NON-REJECTED milestone total minus finalized
        // tranches: a terminally rejected tranche will never disburse, so
        // encumbering the whole grant amount would strand its share of the
        // liquidity forever (W12).
        const owedParts: string[] = [];
        const finalizedParts: string[] = [];
        for (const milestone of grant.milestones) {
          if (milestone.state === 'rejected') continue;
          owedParts.push(milestone.amount);
          if (milestone.paymentIntentId === null) continue;
          const linked = await deps.intents.getById(milestone.paymentIntentId);
          if (linked?.executionState === 'finalized') finalizedParts.push(milestone.amount);
        }
        const outstanding = decSum([decSum(owedParts), `-${decSum(finalizedParts)}`]);
        if (!outstanding.startsWith('-')) obligationParts.push(outstanding);
      }
      if (page.length < 500) break;
      grantCursor = page[page.length - 1]?.grantId ?? null;
      if (grantCursor === null) break;
    }
    const encumbered = decSum(obligationParts);
    const liquid = decSum([balance, `-${alreadyReserved}`, `-${encumbered}`]);
    if (liquid.startsWith('-') || decCompare(input.create.requested_amount, liquid) > 0) {
      return tgErr(409, 'insufficient_funds', 'The treasury cannot cover this proposal.');
    }
    // Recipient sanctions screening (fail-closed on real-funds deployments).
    const deployment = pinnedDeployment(treasury.deploymentId);
    const realFunds =
      deployment !== undefined &&
      (deployment.environment === 'capped_production' ||
        deployment.environment === 'mature_production');
    // Address screening applies to ADDRESS-shaped recipients only — an opaque
    // ref (`user:…`, a co-op name) is not an on-chain address and would either
    // fail closed spuriously or be screened as meaningless text.  The eventual
    // on-chain payout is screened again at the WS-L action layer regardless.
    const recipientLower = (input.create.recipient_ref ?? '').toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(recipientLower)) {
      const screen = await deps.compliance.screenAddress({
        addressLower: recipientLower,
        deploymentId: treasury.deploymentId,
      });
      if (screen === 'blocked') {
        return tgErr(422, 'sanctions_blocked', 'This proposal cannot be completed.');
      }
      if (screen === 'unavailable' && realFunds) {
        return tgErr(503, 'screening_unavailable', 'Recipient screening is unavailable.');
      }
    }
  }

  // Action budget (§17.7): charge AFTER every rejection-only check above (a
  // rejected draft must not silently burn the member's allowance, W15) and
  // BEFORE the insert side effect; free when unconfigured.  The only failure
  // past this point is the duplicate-insert race, which refunds below.
  const budget = await chargeRoomActionBudget(deps, {
    roomId: input.roomId,
    userId: input.userId,
    actionType: 'proposal_submission',
    rules: active.pack.actionBudgetRules ?? NO_BUDGET_RULES,
  });
  if ('code' in budget) return budget;

  const nowMs = deps.now();
  const config = deps.wsmProposalConfig();
  const deliberationEndsAt = new Date(nowMs + config.wsmDeliberationSeconds * 1000).toISOString();
  const votingEndsAt = new Date(
    nowMs + (config.wsmDeliberationSeconds + config.wsmVotingSeconds) * 1000,
  ).toISOString();
  const record: GovernanceProposalRecord = {
    proposalId,
    roomId: input.roomId,
    proposerUserId: input.userId,
    proposalType,
    title: input.create.title,
    plainLanguageSummary: input.create.plain_language_summary,
    requestedAmount: input.create.requested_amount,
    asset: input.create.asset,
    recipientRef: input.create.recipient_ref,
    conflictDisclosures: input.create.conflict_disclosures,
    riskAssessment: input.create.risk_assessment,
    requestedAction: input.create.requested_action,
    expectedDeliverable: input.create.expected_deliverable,
    preflightState: 'passed',
    votingState: 'deliberation',
    challengeState: 'none',
    executionState: 'not_executed',
    simulationMode: false,
    executableAfter: null,
    createdAt: new Date(nowMs).toISOString(),
    executedAt: null,
    executionClaimedAt: null,
    lawPackVersionId: active.record.lawPackId,
    category: spendCategory,
    deliberationEndsAt,
    votingEndsAt,
    challengeWindowEndsAt: null,
    tallySnapshot: null,
  };
  try {
    await deps.proposals.insert(record);
  } catch (error) {
    // Two concurrent creates with the same idempotency key both passed the
    // read above; the primary key (the deterministic id IS the idempotency
    // record) makes the loser land here — return the winner's row instead of
    // surfacing a 500.  (The SQLSTATE rides the Drizzle cause chain — see
    // `isUniqueViolation`.)
    if (isUniqueViolation(error)) {
      const winner = await deps.proposals.getById(proposalId);
      if (winner !== null) {
        // The loser charged the action budget above but published nothing —
        // credit the charge back so a retry storm cannot drain the allowance
        // for one accepted proposal.
        await refundActionBudget(deps, {
          roomId: input.roomId,
          userId: input.userId,
          units: budget.charged,
          rules: active.pack.actionBudgetRules ?? NO_BUDGET_RULES,
        });
        return { ok: true, proposal: winner };
      }
    }
    throw error;
  }
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'proposal_published',
    actorUserId: input.userId,
    details: {
      proposal_id: proposalId,
      proposal_type: proposalType,
      law_pack_version_id: active.record.lawPackId,
      category: spendCategory,
    },
    proposalId,
  });
  return { ok: true, proposal: record };
}

// ---------------------------------------------------------------------------
// Signing / voting (WS-M.2.3b-1 + 4.2c)
// ---------------------------------------------------------------------------

export interface SignProposalInput {
  roomId: string;
  proposalId: string;
  userId: string;
  purpose: 'vote' | 'approval' | 'multisig';
  choice: 'approve' | 'reject' | 'abstain' | null;
  deploymentId: string;
  walletAccountId: string;
  typedDataMessage: Record<string, string>;
  signature: string;
}

export async function signProposal(
  deps: ProposalDeps,
  input: SignProposalInput,
): Promise<
  | TreasuryGovernanceError
  | { ok: true; signature: GovernanceSignatureRecord; tally: ProposalTallyWire }
> {
  const guard = await assertGovernanceWritable(deps, input.roomId, 'voting');
  if (guard !== null) return guard;
  const region = await deps.regionResolver.regionForUser(input.userId);
  const killSwitch = await killSwitchDecision(deps.configStore, 'governance_voting', {
    roomId: input.roomId,
    region,
  });
  if (killSwitch.engaged) {
    return tgErr(503, 'kill_switch_active', 'Voting is temporarily paused.');
  }
  const proposal = await deps.proposals.getById(input.proposalId);
  if (proposal === null || proposal.roomId !== input.roomId || proposal.simulationMode) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  // BALLOTS live inside the voting window; approval/multisig signatures are
  // an EXECUTION-phase act (§17.5: designated signers co-sign a PASSED
  // proposal before it may execute) and are gated by the phase check below.
  if (input.purpose === 'vote') {
    if (proposal.votingState !== 'open') {
      return tgErr(
        409,
        proposal.votingState === 'deliberation' ? 'still_deliberating' : 'voting_closed',
        proposal.votingState === 'deliberation'
          ? 'The deliberation window has not ended yet.'
          : 'Voting on this proposal has closed.',
      );
    }
    // The DEADLINE closes voting, not the (possibly lagging) settle sweep: a
    // signature recorded after votingEndsAt would still count in the eventual
    // tally, letting scheduler lag change a decided outcome.
    const nowIsoForVote = new Date(deps.now()).toISOString();
    if (proposal.votingEndsAt != null && proposal.votingEndsAt <= nowIsoForVote) {
      return tgErr(409, 'voting_closed', 'Voting on this proposal has closed.');
    }
    if (input.choice === null) {
      return tgErr(400, 'choice_required', 'A vote requires a choice.');
    }
  } else {
    // An execution co-signature attests a DECIDED outcome: recording it while
    // voting is still open would let signers pre-approve a proposal that has
    // not passed, with the stale rows later satisfying the multisig count (W9).
    if (proposal.votingState !== 'passed') {
      return tgErr(409, 'not_approvable', 'Approval signatures apply to passed proposals only.');
    }
    // An approval/multisig co-signature is CHOICE-NEUTRAL: execution counts
    // every such row as affirmative, so a signed `reject` choice riding an
    // approval purpose would satisfy the multisig gate while reading as a no.
    if (input.choice !== null) {
      return tgErr(400, 'choice_not_allowed', 'Approval signatures carry no ballot choice.');
    }
  }

  // --- WS-L signature verification (the SAME verifiers, never a parallel path).
  const wallet = await deps.wallets.getById(input.walletAccountId);
  if (wallet === null || wallet.userId !== input.userId || wallet.unlinkState !== 'active') {
    return tgErr(403, 'wallet_not_active', 'The selected wallet is not active.');
  }
  const deployment = pinnedDeployment(input.deploymentId);
  if (deployment?.status !== 'active') {
    return tgErr(409, 'deployment_unknown', 'Unknown or inactive deployment.');
  }
  // The ballot must ride the ROOM's deployment (W13): with several active
  // deployments, a wallet on another chain could otherwise record a
  // production signature that execution never re-checks.
  const roomTreasury = await deps.treasuries.getByRoom(input.roomId);
  if (roomTreasury !== null && roomTreasury.deploymentId !== input.deploymentId) {
    return tgErr(409, 'deployment_mismatch', 'Sign with the room treasury’s deployment.');
  }
  if (wallet.chainId !== deployment.chain_id) {
    return tgErr(409, 'wallet_chain_mismatch', 'The wallet is linked on a different chain.');
  }
  const verified = await verifyActionSignature({
    actionType: 'proposal_sign',
    domain: buildEip712Domain(deployment),
    message: input.typedDataMessage,
    signature: input.signature,
    contractVerifier: deps.contractVerifier,
  });
  if (!verified.ok) {
    return tgErr(422, 'signature_invalid', 'The signed payload failed validation.');
  }
  if (
    hashFinancialWalletAddress(deps.masterSecret, verified.actorLower) !== wallet.addressHashHex
  ) {
    return tgErr(422, 'signature_invalid', 'The signer is not the selected wallet.');
  }
  const message = input.typedDataMessage;
  if (message['proposalId'] !== input.proposalId || message['roomId'] !== input.roomId) {
    return tgErr(422, 'payload_mismatch', 'The signed payload targets a different proposal.');
  }
  // The §17.3.1 binding quartet includes the deployment: what the voter SAW
  // in the signed message must be the deployment this ballot is recorded
  // under (parity with the WS-L preflight path).
  if (message['deploymentId'] !== input.deploymentId) {
    return tgErr(422, 'payload_mismatch', 'The signed payload binds a different deployment.');
  }
  // Registry v2: the BALLOT ITSELF is signed — the wallet-approved payload
  // carries purpose + choice, so the unsigned JSON can never repurpose one
  // signature as a different vote.
  if (message['purpose'] !== input.purpose || message['choice'] !== (input.choice ?? 'none')) {
    return tgErr(422, 'payload_mismatch', 'The signed ballot differs from the request.');
  }
  const nonce = message['nonce'] ?? '';
  if (nonce === '') return tgErr(422, 'nonce_required', 'The signed payload needs a nonce.');
  // Signatures over expired typed data are rejected (WS-M.2.3b-1).
  const expiration = Number.parseInt(message['expiration'] ?? '', 10);
  if (!Number.isFinite(expiration) || expiration * 1000 <= deps.now()) {
    return tgErr(422, 'expired', 'The signature expiration is invalid or has passed.');
  }

  // --- Eligibility gate BEFORE weight resolution (WS-M.4.2c-2).
  const active = await activeLawPack(deps, input.roomId);
  const pack = active?.pack ?? null;
  // The proposal evaluates under ITS pinned pack when still resolvable.
  const pinned =
    proposal.lawPackVersionId != null ? await deps.lawPacks.get(proposal.lawPackVersionId) : null;
  const evalPack: LawPack | null = pinned !== null ? (pinned.lawPack as LawPack) : pack;
  if (evalPack === null) return tgErr(409, 'no_law_pack', 'No law-pack applies to this proposal.');

  const facts = await deps.membership.memberFacts(input.roomId, input.userId);
  // Treasury-CONTROLLING is broader than spend-bearing: a vote that rewrites
  // the treasury's rules (law-pack upgrade, treasury policy) controls the
  // treasury as surely as a vote that spends from it — the wallet cooling-off
  // and the other treasury-specific voter gates apply to both.
  const spendControlling = isTreasuryControlling(proposal);
  // The cooling-off binds the member's NEWEST active wallet — voting with an
  // older wallet while a fresh one exists would bypass the §17.5 control.
  const activeWallets = (await deps.wallets.listByUser(input.userId, false)).filter(
    (w) => w.unlinkState === 'active',
  );
  const newestLinkedAt = activeWallets.reduce(
    (newest, w) => Math.max(newest, Date.parse(w.linkedAt)),
    Date.parse(wallet.linkedAt),
  );
  const walletAgeDays = Math.floor((deps.now() - newestLinkedAt) / 86_400_000);
  const voterFacts: VoterFacts = {
    userId: input.userId,
    membershipDays: facts?.membershipDays ?? null,
    contributionCount: facts?.contributionCount ?? null,
    verifiedIdentity: facts?.verifiedIdentity ?? false,
    newestWalletAgeDays: walletAgeDays,
    walletClusterId: null, // cluster heuristics: WS-N seam (null = no cluster)
    // Conflicted voters: the proposer who disclosed a COI, AND the actual
    // grant/bounty RECIPIENT — a member being paid by the proposal has the
    // definitional stake, whether or not anyone disclosed it (WS-M.2.3d).
    hasDisclosedConflict:
      (proposal.conflictDisclosures !== null && proposal.proposerUserId === input.userId) ||
      proposal.recipientRef === input.userId ||
      proposal.recipientRef === `user:${input.userId}`,
    roleClasses: (await deps.rooms.isSteward(input.roomId, input.userId)) ? ['steward'] : [],
    reputationScore: 0,
    tokenVoteUnits: 0,
    isDesignatedSigner: evalPack.multisig?.signers.includes(input.userId) ?? false,
  };
  const eligibility = checkVoterEligibility(voterFacts, {
    rules: evalPack.eligibility ?? {
      minMembershipDays: 0,
      minContributions: 0,
      requireVerifiedIdentity: false,
      newWalletCoolingOffDays: 0,
    },
    treasuryControlling: spendControlling,
    recusalRequired:
      (evalPack.coiRequirements?.recusalRequired ?? false) &&
      (evalPack.coiRequirements?.independentReviewFor.includes(proposal.proposalType) ?? false),
    clustersAlreadyVoted: new Set(),
  });
  if (!eligibility.eligible) {
    return tgErr(403, eligibility.code, eligibility.reason);
  }
  if (!(await deps.rooms.isMember(input.roomId, input.userId))) {
    return tgErr(403, 'not_member', 'Only room members can vote.');
  }

  // --- Weight resolution (WS-M.4.2c-1): capped, explainable, gated fail-closed.
  const model = evalPack.weightModel ?? 'one_civic_account_one_vote';
  const delegations = await incomingDelegationsFor(
    deps.delegations,
    input.roomId,
    input.userId,
    proposal.proposalType,
  );
  // A delegator who already cast their OWN ballot on this proposal keeps it —
  // their weight must not also ride the delegate's signature (double-count).
  const priorSignatures = await deps.proposalSignatures.listByProposal(input.proposalId);
  // The EARLIEST weight-resolved vote instant per voter: a delegate's
  // `weightSnapshot` was fixed WHEN they voted, so only delegations that existed
  // by then are inside it.
  const voteTimeByUser = new Map<string, string>();
  for (const s of priorSignatures) {
    if (s.purpose !== 'vote' || s.weightSnapshot == null) continue;
    const existing = voteTimeByUser.get(s.userId);
    if (existing === undefined || s.createdAt < existing) voteTimeByUser.set(s.userId, s.createdAt);
  }
  const alreadyVoted = new Set(voteTimeByUser.keys());
  // The SYMMETRIC mitigation (WS-M.4.2c-1): the incoming-side guard above stops a
  // delegator-first double-count, but if the DELEGATE signed first, the
  // delegator's weight is already inside the delegate's snapshot — a later DIRECT
  // ballot by the delegator would count that unit twice.  Refuse the direct vote
  // ONLY when the delegation was created at/before the delegate's ballot (so it
  // was actually in that snapshot); a delegation created AFTER the delegate voted
  // was never counted, so the delegator's direct vote stands.
  if (model === 'delegated' && input.purpose === 'vote') {
    // The SHARED predicate, so this guard and the incoming one below cannot
    // drift apart again.  It reads EVERY delegation state, not just `active`:
    // revoking after the delegate signed removed this check's evidence while
    // leaving the weight inside the delegate's frozen snapshot, so the
    // delegator could cast the same unit a second time — and the error message
    // two lines down ("revoke the delegation to vote directly") walked them
    // straight through it.
    const consumed = await delegatorsAlreadyConsumed(
      deps.delegations,
      input.roomId,
      proposal.proposalType,
      [input.userId],
      voteTimeByUser,
      null,
    );
    if (consumed.has(input.userId)) {
      return tgErr(
        409,
        'delegated_weight_already_cast',
        'Your vote was already cast via your delegate. Revoking the delegation does not ' +
          'return the weight — that ballot is already counted.',
      );
    }
  }
  // …and the SAME predicate on the incoming side.  `incomingDelegationsFor`
  // dedups a delegator who granted both an `all` and a `type:` delegation to
  // THIS delegate, but it reads one delegate at a time — so a member who split
  // the two across two DIFFERENT delegates had their unit counted once in each
  // ballot.  `alreadyVoted` does not catch it either: that delegator never
  // voted directly.
  const consumedElsewhere = await delegatorsAlreadyConsumed(
    deps.delegations,
    input.roomId,
    proposal.proposalType,
    delegations.flatMap((d) => (d.delegatorUserId === null ? [] : [d.delegatorUserId])),
    voteTimeByUser,
    input.userId,
  );
  const incoming = [];
  for (const delegation of delegations) {
    if (delegation.delegatorUserId !== null && alreadyVoted.has(delegation.delegatorUserId)) {
      continue;
    }
    if (delegation.delegatorUserId !== null && consumedElsewhere.has(delegation.delegatorUserId)) {
      continue;
    }
    let delegatorEligible = false;
    if (
      delegation.delegatorUserId !== null &&
      (await deps.rooms.isMember(input.roomId, delegation.delegatorUserId))
    ) {
      // The delegator must pass the SAME law-pack eligibility gate as a direct
      // voter (membership age, contributions, identity) — otherwise ineligible
      // members boost a delegate's ballot they could never cast themselves.
      // Wallet arms are neutral here: delegating involves no wallet.
      const delegatorFacts = await deps.membership.memberFacts(
        input.roomId,
        delegation.delegatorUserId,
      );
      const verdict = checkVoterEligibility(
        {
          userId: delegation.delegatorUserId,
          membershipDays: delegatorFacts?.membershipDays ?? null,
          contributionCount: delegatorFacts?.contributionCount ?? null,
          verifiedIdentity: delegatorFacts?.verifiedIdentity ?? false,
          newestWalletAgeDays: Number.MAX_SAFE_INTEGER,
          walletClusterId: null,
          // COI recusal applies to DELEGATED units too: a conflicted proposer
          // or grant recipient must not route their weight around the recusal
          // by delegating before the delegate signs.
          hasDisclosedConflict:
            (proposal.conflictDisclosures !== null &&
              proposal.proposerUserId === delegation.delegatorUserId) ||
            proposal.recipientRef === delegation.delegatorUserId ||
            proposal.recipientRef === `user:${delegation.delegatorUserId}`,
          roleClasses: [],
          reputationScore: 0,
          tokenVoteUnits: 0,
          isDesignatedSigner: false,
        },
        {
          rules: evalPack.eligibility ?? {
            minMembershipDays: 0,
            minContributions: 0,
            requireVerifiedIdentity: false,
            newWalletCoolingOffDays: 0,
          },
          treasuryControlling: spendControlling,
          recusalRequired:
            (evalPack.coiRequirements?.recusalRequired ?? false) &&
            (evalPack.coiRequirements?.independentReviewFor.includes(proposal.proposalType) ??
              false),
          clustersAlreadyVoted: new Set(),
        },
      );
      delegatorEligible = verdict.eligible;
    }
    incoming.push({
      delegatorUserId: delegation.delegatorUserId ?? '',
      delegatorEligible,
      weight: 1,
    });
  }
  const resolution: WeightResolution = resolveVotingWeight({
    model,
    facts: voterFacts,
    maxVotingWeightPerAccount: evalPack.maxVotingWeightPerAccount ?? 1,
    // §17.5 gated models refuse until Sybil/anti-bribery/legal review are
    // RECORDED — no recording mechanism exists yet, so they stay refused (MVP).
    gates: {
      sybilControlsVerified: false,
      antiBriberyMonitoring: false,
      legalReviewPassed: false,
    },
    delegations: incoming,
  });
  if (!resolution.resolved) {
    return tgErr(409, resolution.code, resolution.reason);
  }

  const record: GovernanceSignatureRecord = {
    signatureId: deps.uuid(),
    proposalId: input.proposalId,
    userId: input.userId,
    walletAccountId: input.walletAccountId,
    signatureType: verified.walletType === 'contract' ? 'eip712_eip1271' : 'eip712_ecdsa',
    typedDataHash: verified.typedDataHash,
    signatureRef: input.signature,
    weightSnapshot: resolution.weight,
    eligibilityReason: resolution.eligibilityReason,
    createdAt: new Date(deps.now()).toISOString(),
    purpose: input.purpose,
    choice: input.purpose === 'vote' ? input.choice : null,
    nonce,
  };
  const inserted = await deps.proposalSignatures.insert(record);
  if (inserted === null) {
    return tgErr(409, 'already_signed', 'A signature by this user/wallet/nonce already exists.');
  }
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'vote_signature_recorded',
    actorUserId: input.userId,
    // Tallies are public; INDIVIDUAL choices stay out of the public audit
    // payload (law-pack-configurable visibility, WS-M.4.2c).
    details: { proposal_id: input.proposalId, purpose: input.purpose },
    proposalId: input.proposalId,
  });
  const tally = await tallyFor(deps, proposal, evalPack, false);
  return { ok: true, signature: inserted, tally: wireTally(tally) };
}

// ---------------------------------------------------------------------------
// The deadline sweep (WS-M.4.2d) + execution-window expiry
// ---------------------------------------------------------------------------

export async function settleDueProposals(deps: ProposalDeps, roomId: string): Promise<number> {
  // A frozen room's governance is PAUSED wholesale: deadlines must not settle
  // votes, start timelocks, or encumber treasury headroom mid-review.  The
  // sweep simply defers — settlement resumes once the freeze lifts (ballots
  // stayed deadline-gated throughout, so the eventual tally is unchanged).
  const profile = await deps.profiles.get(roomId);
  if (profile?.freezeState === 'frozen') return 0;
  const nowIso = new Date(deps.now()).toISOString();
  // Enumerate UNSETTLED production rows (deliberation/open/timelocked/
  // executing) via keyset pages — bounded by live work AND exhaustive, so a
  // busy room's newer not-yet-due proposals can never starve an older due one.
  const proposals: GovernanceProposalRecord[] = [];
  let afterId: string | null = null;
  for (;;) {
    const page = await deps.proposals.listUnsettledByRoom(roomId, 500, afterId);
    proposals.push(...page);
    if (page.length < 500) break;
    afterId = page[page.length - 1]?.proposalId ?? null;
    if (afterId === null) break;
  }
  let settled = 0;
  for (const proposal of proposals) {
    if (proposal.simulationMode) continue;
    // deliberation → open at the deliberation deadline.
    if (
      proposal.votingState === 'deliberation' &&
      proposal.deliberationEndsAt != null &&
      proposal.deliberationEndsAt <= nowIso
    ) {
      const opened = await deps.proposals.casVotingState(
        proposal.proposalId,
        'deliberation',
        'open',
        {},
      );
      if (opened !== null) settled += 1;
      continue;
    }
    // open → terminal at the voting deadline (kernel tally, WS-M.4.2d).
    if (
      proposal.votingState === 'open' &&
      proposal.votingEndsAt != null &&
      proposal.votingEndsAt <= nowIso
    ) {
      const pinned =
        proposal.lawPackVersionId != null
          ? await deps.lawPacks.get(proposal.lawPackVersionId)
          : null;
      const pack = (pinned?.lawPack ?? (await activeLawPack(deps, roomId))?.pack) as
        | LawPack
        | undefined;
      if (pack === undefined) continue;
      const tally = await tallyFor(deps, proposal, pack, true);
      const config = deps.wsmProposalConfig();
      if (tally.outcome === 'passed') {
        // A PASS starts the timelock and RESERVES spend headroom — fund
        // movement.  A treasury-scope freeze leaves the room profile active,
        // so the room-level deferral above does not cover it: run the same
        // executions guard the payment lifecycle uses and DEFER this
        // proposal while the treasury is frozen/divergent (it settles once
        // the hold lifts; ballots stayed deadline-gated throughout) (W10).
        if ((await assertGovernanceWritable(deps, roomId, 'executions')) !== null) {
          continue;
        }
        const timelockSeconds =
          pack.timelockRules?.[proposal.proposalType]?.seconds ?? config.wsmChallengeWindowSeconds;
        const settledRow = await deps.proposals.casVotingState(
          proposal.proposalId,
          'open',
          'passed',
          {
            executionState: 'timelocked',
            executableAfter: new Date(deps.now() + timelockSeconds * 1000).toISOString(),
            challengeWindowEndsAt: new Date(
              deps.now() + config.wsmChallengeWindowSeconds * 1000,
            ).toISOString(),
            tallySnapshot: wireTally(tally) as unknown as Record<string, unknown>,
          },
        );
        if (settledRow === null) continue;
        // Reserve the spend at approval (WS-M.2.3a-1).  A failed reservation
        // (headroom consumed since preflight) BLOCKS execution honestly.
        if (settledRow.category !== null && settledRow.category !== undefined) {
          const treasury = await deps.treasuries.getByRoom(roomId);
          if (treasury !== null && settledRow.requestedAmount !== null) {
            const reserved = await reserveForProposal(deps, {
              treasuryId: treasury.treasuryId,
              proposalId: settledRow.proposalId,
              category: settledRow.category,
              asset: settledRow.asset ?? '',
              amount: settledRow.requestedAmount,
              bounds: pack.treasury,
            });
            if ('code' in reserved) {
              await deps.proposals.casExecutionState(
                settledRow.proposalId,
                ['timelocked'],
                'blocked',
              );
              await appendChainedAudit(deps, {
                roomId,
                actionType: 'proposal_execution_failed',
                actorUserId: null,
                details: { proposal_id: settledRow.proposalId, code: reserved.code },
                proposalId: settledRow.proposalId,
              });
            }
          }
        }
      } else {
        // A contended sweep can lose this CAS to a sibling that already
        // closed the row — auditing a transition that did not happen would
        // forge history (W11).
        const closed = await deps.proposals.casVotingState(
          proposal.proposalId,
          'open',
          tally.outcome,
          { tallySnapshot: wireTally(tally) as unknown as Record<string, unknown> },
        );
        if (closed === null) continue;
      }
      await appendChainedAudit(deps, {
        roomId,
        actionType: 'proposal_voting_settled',
        actorUserId: null,
        details: { proposal_id: proposal.proposalId, outcome: tally.outcome },
        proposalId: proposal.proposalId,
      });
      settled += 1;
      continue;
    }
    // A claim stranded mid-execution (a crash between claim and finalize/
    // block) is released honestly after the execution window: blocked +
    // reservation released, never a permanent `executing` wedge (W3 review).
    if (
      proposal.votingState === 'passed' &&
      proposal.executionState === 'executing' &&
      proposal.executionClaimedAt !== null &&
      deps.now() - Date.parse(proposal.executionClaimedAt) >
        deps.wsmProposalConfig().wsmExecutionWindowSeconds * 1000
    ) {
      await deps.proposals.casExecutionState(proposal.proposalId, ['executing'], 'blocked', {
        clearClaim: true,
      });
      await releaseReservation(deps, proposal.proposalId);
      await appendChainedAudit(deps, {
        roomId,
        actionType: 'proposal_execution_failed',
        actorUserId: null,
        details: { proposal_id: proposal.proposalId, code: 'execution_stranded' },
        proposalId: proposal.proposalId,
      });
      settled += 1;
      continue;
    }
    // Passed but never executed inside the execution window → expired.
    if (
      proposal.votingState === 'passed' &&
      proposal.executionState === 'timelocked' &&
      proposal.executableAfter !== null
    ) {
      // An unresolved challenge is the only thing BLOCKING execution — the
      // window must not burn down while review is pending, or a later
      // dismissal could never restore an executable proposal.
      if (
        proposal.challengeState === 'open' ||
        proposal.challengeState === 'escalated' ||
        (await deps.challenges.countOpenByProposal(proposal.proposalId)) > 0
      ) {
        continue;
      }
      const expiryMs =
        Date.parse(proposal.executableAfter) +
        deps.wsmProposalConfig().wsmExecutionWindowSeconds * 1000;
      if (deps.now() >= expiryMs) {
        // The claim CAS guarantees exclusivity against a racing execute.
        const claimed = await deps.proposals.claimForExecution(proposal.proposalId, nowIso);
        if (claimed !== null) {
          await deps.proposals.casExecutionState(proposal.proposalId, ['executing'], 'expired', {
            clearClaim: true,
          });
          await releaseReservation(deps, proposal.proposalId);
          await appendChainedAudit(deps, {
            roomId,
            actionType: 'proposal_execution_failed',
            actorUserId: null,
            details: { proposal_id: proposal.proposalId, code: 'execution_window_expired' },
            proposalId: proposal.proposalId,
          });
          settled += 1;
        }
      }
    }
  }
  return settled;
}

// ---------------------------------------------------------------------------
// Challenges (WS-M.4.3a)
// ---------------------------------------------------------------------------

export async function fileChallenge(
  deps: ProposalDeps,
  input: {
    roomId: string;
    proposalId: string;
    userId: string;
    challengeType: ChallengeRecord['challengeType'];
    description: string;
    evidenceRefs: string[];
  },
): Promise<TreasuryGovernanceError | { ok: true; challenge: ChallengeRecord }> {
  const proposal = await deps.proposals.getById(input.proposalId);
  if (proposal === null || proposal.roomId !== input.roomId || proposal.simulationMode) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  // A frozen room's governance is paused wholesale — filing mutates proposal
  // state and creates a new execution blocker mid-review (W11).  Platform
  // review acts through the freeze/challenge-resolution surfaces regardless.
  const writable = await assertGovernanceWritable(deps, input.roomId, 'voting');
  if (writable !== null) return writable;
  if (!(await deps.rooms.isMember(input.roomId, input.userId))) {
    return tgErr(403, 'not_member', 'Only room members can file challenges.');
  }
  const nowIso = new Date(deps.now()).toISOString();
  if (
    proposal.votingState !== 'passed' ||
    proposal.challengeWindowEndsAt == null ||
    proposal.challengeWindowEndsAt <= nowIso ||
    proposal.executionState === 'executed'
  ) {
    return tgErr(409, 'challenge_window_closed', 'The challenge window is not open.');
  }
  // ONE open challenge per (proposal, challenger) — without the cap a single
  // member could stack unresolved challenges and hold execution hostage
  // (each needs an independent steward/platform disposition) (sweep).
  const siblings = await deps.challenges.listByProposal(input.proposalId);
  if (siblings.some((c) => c.challengerUserId === input.userId && c.state === 'open')) {
    return tgErr(
      409,
      'challenge_already_open',
      'You already have an open challenge on this proposal.',
    );
  }
  const challenge: ChallengeRecord = {
    challengeId: deps.uuid(),
    proposalId: input.proposalId,
    challengerUserId: input.userId,
    challengeType: input.challengeType,
    description: input.description,
    evidenceRefs: input.evidenceRefs,
    state: 'open',
    resolutionNote: null,
    resolvedByUserId: null,
    createdAt: nowIso,
    resolvedAt: null,
  };
  await deps.challenges.insert(challenge);
  await deps.proposals.applyChallengeProjection(input.proposalId, { challengeState: 'open' });
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'challenge_filed',
    actorUserId: input.userId,
    details: {
      proposal_id: input.proposalId,
      challenge_id: challenge.challengeId,
      challenge_type: input.challengeType,
    },
    proposalId: input.proposalId,
  });
  return { ok: true, challenge };
}

/** NOTE (sweep): deliberately OUTSIDE the writability guard — resolution is
 *  the REVIEW machinery itself (stewards/platform must be able to dispose of
 *  challenges while the room is frozen for that very review). */
export async function resolveChallenge(
  deps: ProposalDeps,
  input: {
    roomId: string;
    challengeId: string;
    resolution: 'upheld' | 'dismissed' | 'escalated';
    resolutionNote: string;
    actorUserId: string;
    isPlatformStaff: boolean;
  },
): Promise<TreasuryGovernanceError | { ok: true; challenge: ChallengeRecord }> {
  const challenge = await deps.challenges.getById(input.challengeId);
  if (challenge === null) return tgErr(404, 'not_found', 'Resource not found');
  const proposal = await deps.proposals.getById(challenge.proposalId);
  if (proposal === null || proposal.roomId !== input.roomId) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  // Legal/capture challenges reach PLATFORM actors (WS-M.4.3a): only platform
  // staff can give them a final disposition; stewards may escalate.
  const platformClass =
    challenge.challengeType === 'legal' || challenge.challengeType === 'capture';
  if (input.resolution === 'escalated') {
    // Escalation BLOCKS execution, so it is a steward/platform act too — any
    // member reaching this state at will would be a free execution veto.
    if (!input.isPlatformStaff) {
      const isSteward = await deps.rooms.isSteward(input.roomId, input.actorUserId);
      if (!isSteward) return tgErr(403, 'steward_required', 'Only stewards escalate challenges.');
    }
  } else {
    if (platformClass && !input.isPlatformStaff) {
      return tgErr(403, 'platform_review_required', 'This challenge class needs platform review.');
    }
    if (!platformClass && !input.isPlatformStaff) {
      const isSteward = await deps.rooms.isSteward(input.roomId, input.actorUserId);
      if (!isSteward) return tgErr(403, 'steward_required', 'Only stewards resolve challenges.');
      // A steward may not judge a challenge against their OWN proposal (COI).
      if (proposal.proposerUserId === input.actorUserId) {
        return tgErr(403, 'independent_review_required', 'An independent reviewer must decide.');
      }
    }
  }
  // A DISPOSED challenge is immutable: replaying a resolve against a
  // dismissed/upheld record would rewrite history (e.g. dismissed → upheld
  // after the proposal already executed).  Only open/escalated may resolve,
  // and escalation itself applies only to an open challenge.
  const from = challenge.state;
  if (from !== 'open' && from !== 'escalated') {
    return tgErr(409, 'already_resolved', 'This challenge already has a final disposition.');
  }
  if (input.resolution === 'escalated' && from !== 'open') {
    return tgErr(409, 'invalid_transition', 'Only an open challenge can escalate.');
  }
  const resolved = await deps.challenges.transition(input.challengeId, from, input.resolution, {
    note: input.resolutionNote,
    resolvedByUserId: input.actorUserId,
    resolvedAt: new Date(deps.now()).toISOString(),
  });
  if (resolved === null) {
    return tgErr(409, 'invalid_transition', 'The challenge cannot move to that state.');
  }
  // Project the proposal-level challenge column — COLUMN-scoped (W11): a
  // stale whole-row write here could undo a concurrent execution that claimed
  // the proposal in the gap after the last blocker resolved.
  if (input.resolution === 'upheld') {
    await deps.proposals.applyChallengeProjection(proposal.proposalId, {
      challengeState: 'upheld',
      blockExecution: true, // only a not-yet-executed row blocks
    });
    await releaseReservation(deps, proposal.proposalId);
  } else if (input.resolution === 'escalated') {
    await deps.proposals.applyChallengeProjection(proposal.proposalId, {
      challengeState: 'escalated',
    });
  } else {
    // The proposal-level column is an AGGREGATE over all its challenges:
    // dismissing one must never clear a sibling escalation/upheld verdict
    // (executeProposal gates on this column).
    const siblings = await deps.challenges.listByProposal(proposal.proposalId);
    const aggregate = siblings.some((c) => c.state === 'upheld')
      ? ('upheld' as const)
      : siblings.some((c) => c.state === 'escalated')
        ? ('escalated' as const)
        : siblings.some((c) => c.state === 'open')
          ? ('open' as const)
          : ('dismissed' as const);
    await deps.proposals.applyChallengeProjection(proposal.proposalId, {
      challengeState: aggregate,
      // Dismissing the LAST blocker restarts the execution window for a
      // still-timelocked row: the sweep paused expiry during review, so time
      // spent under challenge must not consume the room's window (W10 pair).
      ...(aggregate === 'dismissed'
        ? { executableAfterFloor: new Date(deps.now()).toISOString() }
        : {}),
    });
  }
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'challenge_resolved',
    actorUserId: input.actorUserId,
    details: {
      proposal_id: proposal.proposalId,
      challenge_id: input.challengeId,
      resolution: input.resolution,
    },
    proposalId: proposal.proposalId,
  });
  return { ok: true, challenge: resolved };
}

// ---------------------------------------------------------------------------
// Execution (WS-M.4.3b) — the caller of the shipped executeTreasuryAction.
// ---------------------------------------------------------------------------

export async function executeProposal(
  deps: ProposalDeps,
  input: { roomId: string; proposalId: string; userId: string },
): Promise<TreasuryGovernanceError | { ok: true; proposal: GovernanceProposalRecord }> {
  const guard = await assertGovernanceWritable(deps, input.roomId, 'executions');
  if (guard !== null) return guard;
  // Explicit, allowlisted executor: the room steward (or platform, via route).
  if (!(await deps.rooms.isSteward(input.roomId, input.userId))) {
    return tgErr(403, 'steward_required', 'Execution requires a room steward.');
  }
  const proposal = await deps.proposals.getById(input.proposalId);
  if (proposal === null || proposal.roomId !== input.roomId || proposal.simulationMode) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  // Re-check EVERY prerequisite at execution time (never a stale "ready").
  const nowIso = new Date(deps.now()).toISOString();
  if (proposal.votingState !== 'passed' || proposal.executionState !== 'timelocked') {
    return tgErr(409, 'not_executable', 'This proposal is not ready to execute.');
  }
  if (proposal.executableAfter === null || proposal.executableAfter > nowIso) {
    return tgErr(409, 'timelocked', 'The timelock has not elapsed yet.');
  }
  // The execution window binds MANUAL execution too: a sweep delay must not
  // let a steward execute a proposal that should already have expired.
  const windowEndsAt = new Date(
    Date.parse(proposal.executableAfter) +
      deps.wsmProposalConfig().wsmExecutionWindowSeconds * 1000,
  ).toISOString();
  if (windowEndsAt <= nowIso) {
    return tgErr(
      409,
      'execution_window_expired',
      'The execution window has closed; the sweep will expire this proposal.',
    );
  }
  if (proposal.challengeWindowEndsAt != null && proposal.challengeWindowEndsAt > nowIso) {
    return tgErr(409, 'challenge_window_open', 'The challenge window has not closed yet.');
  }
  if (proposal.challengeState === 'upheld' || proposal.challengeState === 'escalated') {
    return tgErr(409, 'challenge_blocking', 'A challenge blocks this execution.');
  }
  if ((await deps.challenges.countOpenByProposal(input.proposalId)) > 0) {
    return tgErr(409, 'challenge_blocking', 'Unresolved challenges block execution.');
  }

  // The proposal executes under ITS pinned pack (WS-M.1.3d): a pack swap
  // between publication and the timelock elapsing must not re-cap or
  // re-authorize an already-voted spend under different rules.
  const pinnedRecord =
    proposal.lawPackVersionId != null ? await deps.lawPacks.get(proposal.lawPackVersionId) : null;
  const pinnedPack: LawPack | null =
    pinnedRecord !== null
      ? (pinnedRecord.lawPack as LawPack)
      : ((await activeLawPack(deps, input.roomId))?.pack ?? null);

  // §17.5 multisig-steward execution: when the pinned pack designates N-of-M
  // signers, a single steward cannot execute — the required count of DISTINCT
  // designated signers must have recorded approval/multisig signatures.
  if (pinnedPack?.multisig !== undefined) {
    const signerSet = new Set(pinnedPack.multisig.signers);
    const signatures = await deps.proposalSignatures.listByProposal(input.proposalId);
    const approvals = new Set(
      signatures
        .filter(
          (s) =>
            (s.purpose === 'approval' || s.purpose === 'multisig') &&
            signerSet.has(s.userId) &&
            // Ledger-only rows from the generic WS-L path (null snapshot)
            // never satisfy the execution gate (PR #144 W8).
            s.weightSnapshot != null,
        )
        .map((s) => s.userId),
    );
    if (approvals.size < pinnedPack.multisig.required) {
      return tgErr(
        409,
        'multisig_required',
        `Execution needs ${pinnedPack.multisig.required} designated-signer approvals; ` +
          `${approvals.size} recorded.`,
      );
    }
  }

  // ATOMIC claim (the shipped CAS): two executes cannot both proceed.
  const claimed = await deps.proposals.claimForExecution(input.proposalId, nowIso);
  if (claimed === null) {
    return tgErr(409, 'not_executable', 'This proposal is already being executed.');
  }
  // RE-CHECK the challenge column AFTER the claim (W13): an upheld/escalated
  // resolution can land in the gap between the pre-claim check and the claim
  // itself — executing past it would spend despite the verdict.
  const postClaim = await deps.proposals.getById(input.proposalId);
  if (postClaim?.challengeState === 'upheld' || postClaim?.challengeState === 'escalated') {
    await deps.proposals.casExecutionState(input.proposalId, ['executing'], 'blocked', {
      clearClaim: true,
    });
    return tgErr(409, 'challenge_blocking', 'A challenge blocks this execution.');
  }

  // Route the effect per type.  Treasury categories go through the SHIPPED
  // fail-closed executor (kernel verdict + capability + kill switch) — the
  // WS-U residual's production caller.  The whole post-claim effect block is
  // guarded: an unexpected THROW (executor outage, store error) releases the
  // claim into `blocked` — never a stranded `executing` row that rejects
  // every future execute (W3 review; the sweep also re-drives stale claims).
  let failure: string | null = null;
  try {
    if (claimed.category !== null && claimed.category !== undefined) {
      // Validate the GRANT PLAN before the kernel call: `executeTreasuryAction`
      // appends accepted-spend history immediately, so a malformed milestone
      // plan failing AFTER it would leave a phantom spend consuming future cap
      // headroom (W9).  With the plan proven, grant creation below can only
      // collide idempotently.
      if (
        (claimed.proposalType === 'capped_grant' || claimed.proposalType === 'bounty') &&
        !hasValidMilestonePlan(claimed)
      ) {
        failure = 'grant_creation_failed';
      }
      if (failure === null && (await deps.treasuries.getByRoom(input.roomId)) === null) {
        failure = 'grant_creation_failed';
      }
      const verdict =
        failure !== null
          ? null
          : await deps.treasuryExecutor.execute(input.roomId, {
              category: claimed.category,
              amount: claimed.requestedAmount ?? '0',
              asset: claimed.asset,
              coiDeclared: claimed.conflictDisclosures !== null,
              proposedAt: claimed.createdAt,
              // The PINNED pack rides into the kernel check: the spend was
              // voted and reserved under these caps, and a WS-M room needs no
              // AI-agent binding for a community-passed execution.
              lawPack: pinnedPack,
            });
      if (verdict !== null && !verdict.accepted) {
        failure = verdict.code ?? 'kernel_rejected';
      } else if (verdict !== null) {
        // The grant record is the payout ledger: create it BEFORE consuming the
        // reservation so a malformed milestone plan blocks the execution (with
        // the headroom released) instead of finalizing a spend with no grant.
        if (claimed.proposalType === 'capped_grant' || claimed.proposalType === 'bounty') {
          const grant = await createGrantFromProposal(deps, claimed);
          if (grant === null) failure = 'grant_creation_failed';
        }
        if (failure === null) {
          // A false consume means the reservation is GONE (a concurrent
          // upheld resolution released it) — the spend must not finalize
          // against unencumbered headroom (W13).
          const consumed = await consumeReservation(deps, claimed.proposalId);
          if (!consumed) failure = 'reservation_not_consumable';
        }
      }
    } else if (claimed.proposalType === 'charter_update') {
      // The voted charter content becomes the new version at execution.
      const sections = claimed.requestedAction['sections'];
      const { createCharterVersion } = await import('./charter.js');
      const created = await createCharterVersion(deps, {
        roomId: input.roomId,
        sections,
        actorUserId: input.userId,
      });
      if ('code' in created) failure = created.code;
    } else if (
      claimed.proposalType === 'law_pack_upgrade' ||
      claimed.proposalType === 'treasury_policy_update'
    ) {
      const lawPackId = claimed.requestedAction['law_pack_id'];
      if (typeof lawPackId !== 'string') {
        failure = 'law_pack_id_missing';
      } else {
        const adopted = await adoptLawPack(deps, {
          roomId: input.roomId,
          lawPackId,
          actorUserId: input.userId,
        });
        if ('code' in adopted) failure = adopted.code;
      }
    } else if (claimed.proposalType === 'steward_rotation') {
      const opened = await deps.elections.openElection(input.roomId);
      if (!opened) failure = 'election_not_opened';
    }
  } catch (error) {
    failure = 'execution_error';
    deps.alert?.('wsm.proposal.execution_threw', {
      proposal_id: claimed.proposalId,
      room_id: input.roomId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (failure !== null) {
    // Release the claim honestly: the proposal is blocked, never falsely
    // executed, and the reservation stays released for a corrected retry.
    // COLUMN-scoped CAS (sweep): the claimed snapshot must not write back a
    // challengeState a concurrent resolution changed mid-execution.
    await deps.proposals.casExecutionState(claimed.proposalId, ['executing'], 'blocked', {
      clearClaim: true,
    });
    await releaseReservation(deps, claimed.proposalId);
    await appendChainedAudit(deps, {
      roomId: input.roomId,
      actionType: 'proposal_execution_failed',
      actorUserId: input.userId,
      details: { proposal_id: claimed.proposalId, code: failure },
      proposalId: claimed.proposalId,
    });
    return tgErr(409, failure, 'Execution failed; the proposal is blocked.');
  }

  // FINALIZE before the audit (W13): the side effect is already durable, so
  // an audit-append failure must not leave an `executing` row whose recovery
  // sweep would mark an executed effect blocked.  The audit failure alerts.
  const finalized = await deps.proposals.finalizeExecution(claimed.proposalId, nowIso);
  try {
    await appendChainedAudit(deps, {
      roomId: input.roomId,
      actionType: 'proposal_executed',
      actorUserId: input.userId,
      details: { proposal_id: claimed.proposalId, proposal_type: claimed.proposalType },
      proposalId: claimed.proposalId,
    });
  } catch (error) {
    deps.alert?.('wsm.proposal.execute_audit_failed', {
      proposal_id: claimed.proposalId,
      room_id: input.roomId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    ok: true,
    proposal: finalized ?? { ...claimed, executionState: 'executed', executedAt: nowIso },
  };
}
