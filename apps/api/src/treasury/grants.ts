// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.5.1a — milestone-gated treasury grants.  A grant exists ONLY as the
// product of an executed spend proposal (one per proposal — the unique index
// is the authorization link).  Funds move per ACCEPTED milestone, each tranche
// a payment intent (idempotent per milestone) that rides the full WS-M.3.1b
// lifecycle — never a lump sum where milestones exist.  Acceptance requires
// the independent review to have CLEARED (WS-M.2.3d: grants and bounties are
// exactly the independent-review classes), and the reviewer can be neither
// the proposer nor the recipient.

import { decCompare, decSum } from '@licio/governance';
import type { GovernanceProposalRecord, GovernanceProposalStore } from '../knomosis/stores.js';
import { appendChainedAudit } from './audit-chain.js';
import { createPaymentIntent, type IntentDeps } from './intents.js';
import { type TreasuryGovernanceError, tgErr } from './profile.js';
import type { GrantMilestoneRecord, GrantRecord, GrantStore } from './stores.js';

export interface GrantDeps extends IntentDeps {
  grants: GrantStore;
  proposals: GovernanceProposalStore;
}

/** Build the milestone plan from the proposal's requested action: an explicit
 *  `milestones` array whose tranches sum EXACTLY to the amount, else one
 *  milestone covering the full amount. */
function milestonePlan(
  deps: GrantDeps,
  proposal: GovernanceProposalRecord,
): GrantMilestoneRecord[] | null {
  const amount = proposal.requestedAmount ?? '0';
  const raw = proposal.requestedAction['milestones'];
  if (Array.isArray(raw) && raw.length > 0 && raw.length <= 16) {
    const tranches: GrantMilestoneRecord[] = [];
    for (const entry of raw) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { description?: unknown }).description !== 'string' ||
        typeof (entry as { amount?: unknown }).amount !== 'string'
      ) {
        return null;
      }
      tranches.push({
        milestoneId: deps.uuid(),
        description: (entry as { description: string }).description,
        amount: (entry as { amount: string }).amount,
        state: 'pending',
        paymentIntentId: null,
      });
    }
    // Tranches must sum EXACTLY to the approved amount (exact decimal math):
    // a mismatch could over- or under-disburse past the voted authorization.
    if (decCompare(decSum(tranches.map((t) => t.amount)), amount) !== 0) return null;
    return tranches;
  }
  return [
    {
      milestoneId: deps.uuid(),
      description: proposal.expectedDeliverable,
      amount,
      state: 'pending',
      paymentIntentId: null,
    },
  ];
}

/** Called by proposal execution (WS-M.4.3b) — the ONLY creation path. */
export async function createGrantFromProposal(
  deps: GrantDeps,
  proposal: GovernanceProposalRecord,
): Promise<GrantRecord | null> {
  if (proposal.requestedAmount === null || proposal.asset === null) return null;
  const treasury = await deps.treasuries.getByRoom(proposal.roomId);
  if (treasury === null) return null;
  const milestones = milestonePlan(deps, proposal);
  if (milestones === null) return null;
  const record: GrantRecord = {
    grantId: deps.uuid(),
    roomId: proposal.roomId,
    treasuryId: treasury.treasuryId,
    proposalId: proposal.proposalId,
    recipientRef: proposal.recipientRef ?? 'unknown',
    purpose: proposal.plainLanguageSummary,
    amount: proposal.requestedAmount,
    asset: proposal.asset,
    milestones,
    milestoneState: 'pending',
    reviewState: 'pending',
    payoutState: 'not_started',
    auditSummary: null,
    createdAt: new Date(deps.now()).toISOString(),
  };
  const inserted = await deps.grants.insert(record);
  if (inserted === null) return deps.grants.getByProposal(proposal.proposalId);
  await appendChainedAudit(deps, {
    roomId: proposal.roomId,
    actionType: 'grant_created',
    actorUserId: proposal.proposerUserId,
    details: {
      grant_id: inserted.grantId,
      proposal_id: proposal.proposalId,
      milestones: milestones.length,
      amount: inserted.amount,
    },
    proposalId: proposal.proposalId,
    treasuryId: treasury.treasuryId,
  });
  return inserted;
}

/** WS-M.2.3d independent review: the reviewer must be neither the proposer
 *  nor the recipient; clearance is the gate milestone acceptance requires. */
export async function setGrantReview(
  deps: GrantDeps,
  input: {
    roomId: string;
    grantId: string;
    reviewState: 'independent_review' | 'cleared' | 'flagged';
    reviewerUserId: string;
  },
): Promise<TreasuryGovernanceError | { ok: true; grant: GrantRecord }> {
  const grant = await deps.grants.getById(input.grantId);
  if (grant === null || grant.roomId !== input.roomId) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  const proposal = await deps.proposals.getById(grant.proposalId);
  if (
    proposal?.proposerUserId === input.reviewerUserId ||
    grant.recipientRef === `user:${input.reviewerUserId}` ||
    grant.recipientRef === input.reviewerUserId
  ) {
    return tgErr(
      403,
      'independent_review_required',
      'The reviewer must have no stake in the grant (WS-M.2.3d).',
    );
  }
  const updated = await deps.grants.update({ ...grant, reviewState: input.reviewState });
  if (updated === null) return tgErr(404, 'not_found', 'Resource not found');
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'grant_milestone_updated',
    actorUserId: input.reviewerUserId,
    details: { grant_id: grant.grantId, review_state: input.reviewState },
    treasuryId: grant.treasuryId,
  });
  return { ok: true, grant: updated };
}

/**
 * Milestone transitions (WS-M.5.1a).  `accepted` requires the independent
 * review CLEARED and schedules the tranche as a payment intent (idempotent by
 * milestone id); no lump-sum path exists.
 */
export async function updateGrantMilestone(
  deps: GrantDeps,
  input: {
    roomId: string;
    grantId: string;
    milestoneId: string;
    state: 'in_progress' | 'submitted' | 'accepted' | 'rejected';
    actorUserId: string;
  },
): Promise<TreasuryGovernanceError | { ok: true; grant: GrantRecord }> {
  const grant = await deps.grants.getById(input.grantId);
  if (grant === null || grant.roomId !== input.roomId) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  // A clawed-back grant is DEAD: no milestone may advance (least of all to
  // `accepted`, which would mint a fresh payout intent past the clawback).
  if (grant.payoutState === 'clawed_back') {
    return tgErr(409, 'grant_clawed_back', 'This grant was clawed back; milestones are closed.');
  }
  const milestone = grant.milestones.find((m) => m.milestoneId === input.milestoneId);
  if (milestone === undefined) return tgErr(404, 'not_found', 'Unknown milestone.');
  const legal: Record<string, readonly string[]> = {
    pending: ['in_progress', 'rejected'],
    in_progress: ['submitted', 'rejected'],
    submitted: ['accepted', 'rejected'],
  };
  if (!(legal[milestone.state] ?? []).includes(input.state)) {
    return tgErr(
      409,
      'invalid_transition',
      `A ${milestone.state} milestone cannot ${input.state}.`,
    );
  }
  if (input.state === 'accepted' && grant.reviewState !== 'cleared') {
    return tgErr(
      409,
      'independent_review_required',
      'Milestone acceptance requires the independent review to be cleared.',
    );
  }
  let paymentIntentId = milestone.paymentIntentId;
  if (input.state === 'accepted') {
    const intent = await createPaymentIntent(deps, {
      // ROOM-owned: the payout belongs to the treasury, not to whichever
      // steward happened to accept the milestone.  A null owner makes the
      // milestone-keyed idempotency hold ACROSS stewards (two stewards
      // accepting race to ONE intent) and lets a different steward attach
      // the signed payout action later (no per-user actor binding).
      userId: null,
      roomId: input.roomId,
      targetType: 'grant_payout',
      targetId: grant.grantId,
      asset: grant.asset,
      amount: milestone.amount,
      // Idempotent per milestone: an accept retry maps to the SAME intent.
      idempotencyKey: milestone.milestoneId,
    });
    if ('code' in intent) return intent;
    paymentIntentId = intent.intent.paymentIntentId;
  }
  const milestones = grant.milestones.map((m) =>
    m.milestoneId === input.milestoneId ? { ...m, state: input.state, paymentIntentId } : m,
  );
  // Aggregate projections: the coarse milestone state + the payout state.
  const aggregate = milestones.every((m) => m.state === 'accepted')
    ? ('accepted' as const)
    : milestones.some((m) => m.state === 'rejected')
      ? ('rejected' as const)
      : milestones.some((m) => m.state !== 'pending')
        ? ('in_progress' as const)
        : ('pending' as const);
  // Scheduling only ever moves the grant to `scheduled`: a freshly created
  // payout intent has not been submitted, let alone finalized — `paid` /
  // `partially_paid` are RECONCILIATION verdicts, set by the intent sweep
  // when the linked payout intents actually reach on-chain finality.
  const scheduled = milestones.filter((m) => m.paymentIntentId !== null).length;
  const payoutState =
    scheduled === 0 || grant.payoutState === 'partially_paid' || grant.payoutState === 'paid'
      ? grant.payoutState
      : ('scheduled' as const);
  const updated = await deps.grants.update({
    ...grant,
    milestones,
    milestoneState: aggregate,
    payoutState,
  });
  if (updated === null) return tgErr(404, 'not_found', 'Resource not found');
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'grant_milestone_updated',
    actorUserId: input.actorUserId,
    details: {
      grant_id: grant.grantId,
      milestone_id: input.milestoneId,
      state: input.state,
      payment_intent_id: paymentIntentId,
    },
    treasuryId: grant.treasuryId,
  });
  return { ok: true, grant: updated };
}

/** Upheld-dispute reversal where on-chain reversal is possible (WS-M.5.1a). */
export async function markGrantClawedBack(
  deps: GrantDeps,
  input: { roomId: string; grantId: string; actorUserId: string; note: string },
): Promise<TreasuryGovernanceError | { ok: true; grant: GrantRecord }> {
  const grant = await deps.grants.getById(input.grantId);
  if (grant === null || grant.roomId !== input.roomId) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  const updated = await deps.grants.update({
    ...grant,
    payoutState: 'clawed_back',
    auditSummary: input.note,
  });
  if (updated === null) return tgErr(404, 'not_found', 'Resource not found');
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'grant_milestone_updated',
    actorUserId: input.actorUserId,
    details: { grant_id: grant.grantId, payout_state: 'clawed_back' },
    treasuryId: grant.treasuryId,
  });
  return { ok: true, grant: updated };
}
