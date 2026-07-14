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
import { abandonOpenIntent, createPaymentIntent, type IntentDeps } from './intents.js';
import { assertGovernanceWritable, type TreasuryGovernanceError, tgErr } from './profile.js';
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
      // The WIRE bounds (grantMilestoneSchema: description 1..1000): storing
      // an out-of-bounds description would make every later grants read fail
      // response validation for the whole room (W13).
      const description = (entry as { description: string }).description;
      if (description.length < 1 || description.length > 1_000) return null;
      const trancheAmount = (entry as { amount: string }).amount;
      // Every tranche must be a POSITIVE minor-unit integer no larger than the
      // approved amount: the sum check alone would accept `-100` + `200` for a
      // 100-unit grant, and accepting the 200 milestone first disburses above
      // the voted authorization before any offset lands.
      if (
        !/^[0-9]{1,78}$/.test(trancheAmount) ||
        decCompare(trancheAmount, '0') <= 0 ||
        decCompare(trancheAmount, amount) > 0
      ) {
        return null;
      }
      tranches.push({
        milestoneId: deps.uuid(),
        description: (entry as { description: string }).description,
        amount: trancheAmount,
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

/**
 * Whether the proposal's milestone plan CAN build (W9): execution validates
 * this BEFORE the kernel appends accepted-spend history, so a malformed plan
 * blocks with no phantom cap consumption.  Mirrors `milestonePlan` exactly.
 */
export function hasValidMilestonePlan(proposal: GovernanceProposalRecord): boolean {
  if (proposal.requestedAmount === null || proposal.asset === null) return false;
  const amount = proposal.requestedAmount;
  const raw = proposal.requestedAction['milestones'];
  // No explicit array (or one outside 1..16 entries) falls through to the
  // single full-amount milestone — the same branch `milestonePlan` takes.
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16) return true;
  const amounts: string[] = [];
  for (const entry of raw) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { description?: unknown }).description !== 'string' ||
      typeof (entry as { amount?: unknown }).amount !== 'string'
    ) {
      return false;
    }
    const description = (entry as { description: string }).description;
    if (description.length < 1 || description.length > 1_000) return false;
    const trancheAmount = (entry as { amount: string }).amount;
    if (
      !/^[0-9]{1,78}$/.test(trancheAmount) ||
      decCompare(trancheAmount, '0') <= 0 ||
      decCompare(trancheAmount, amount) > 0
    ) {
      return false;
    }
    amounts.push(trancheAmount);
  }
  return decCompare(decSum(amounts), amount) === 0;
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
  // Review clearance is the prerequisite for milestone acceptance and payout
  // scheduling — a frozen room must not advance disbursement state (W8).
  const writable = await assertGovernanceWritable(deps, input.roomId, 'executions');
  if (writable !== null) return writable;
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
  // An ADDRESS-shaped recipient can be the reviewer in disguise: hash it
  // against the reviewer's linked wallets — a steward must not clear the
  // review gate for a grant that pays their own address (W13).
  const recipientLower = grant.recipientRef.toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(recipientLower)) {
    const { hashFinancialWalletAddress } = await import('../identity/siwe.js');
    const recipientHash = hashFinancialWalletAddress(deps.masterSecret, recipientLower);
    const reviewerWallets = await deps.wallets.listByUser(input.reviewerUserId, true);
    if (reviewerWallets.some((w) => w.addressHashHex === recipientHash)) {
      return tgErr(
        403,
        'independent_review_required',
        'The reviewer must have no stake in the grant (WS-M.2.3d).',
      );
    }
  }
  // COLUMN-scoped (W12): never write the milestones snapshot back.
  if (!(await deps.grants.setReviewState(grant.grantId, input.reviewState))) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  const updated = await deps.grants.getById(grant.grantId);
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
  // EVERY milestone transition changes disbursement readiness — a frozen room
  // pauses them all, not just the accept that mints a payout intent (W9).
  const writable = await assertGovernanceWritable(deps, input.roomId, 'executions');
  if (writable !== null) return writable;
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
  // MILESTONE-scoped CAS against the CURRENT row: a whole-record write from
  // the snapshot above would restore another steward's concurrent milestone
  // to its old state (orphaning a scheduled payout or losing an acceptance).
  // The store re-projects the aggregates from the post-patch milestones; the
  // CAS loses when the milestone moved since the legal-transition check.
  const updated = await deps.grants.applyMilestoneTransition(
    input.grantId,
    input.milestoneId,
    milestone.state,
    input.state,
    paymentIntentId,
  );
  if (updated === null) {
    // The CAS lost.  If this accept minted a payout intent, decide its fate
    // from the CURRENT milestone (W11): a concurrent ACCEPT converged on the
    // SAME intent (milestone-keyed idempotency) — leave it linked; anything
    // else (a rejection won the race) orphans it — abandon, or a steward who
    // learns the id could still drive an unlinked room-owned payout.
    if (input.state === 'accepted' && paymentIntentId !== null) {
      const current = await deps.grants.getById(input.grantId);
      const currentMilestone = current?.milestones.find((m) => m.milestoneId === input.milestoneId);
      if (
        currentMilestone?.state !== 'accepted' ||
        currentMilestone.paymentIntentId !== paymentIntentId
      ) {
        await abandonOpenIntent(deps, paymentIntentId);
      }
    }
    return tgErr(409, 'invalid_transition', 'The milestone changed concurrently; re-check.');
  }
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

/** Upheld-dispute reversal where on-chain reversal is possible (WS-M.5.1a).
 *  NOTE (sweep): deliberately OUTSIDE the writability guard — clawback is
 *  platform SAFETY machinery and must work in a frozen room (a freeze often
 *  accompanies the very dispute being reversed). */
export async function markGrantClawedBack(
  deps: GrantDeps,
  input: { roomId: string; grantId: string; actorUserId: string; note: string },
): Promise<TreasuryGovernanceError | { ok: true; grant: GrantRecord }> {
  const grant = await deps.grants.getById(input.grantId);
  if (grant === null || grant.roomId !== input.roomId) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  // COLUMN-scoped (W12): never write the milestones snapshot back.
  if (!(await deps.grants.setPayoutState(grant.grantId, 'clawed_back', input.note))) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  const updated = await deps.grants.getById(grant.grantId);
  if (updated === null) return tgErr(404, 'not_found', 'Resource not found');
  // A clawback CANCELS the grant's open payout intents: a scheduled tranche
  // still in a pre-submission state must not remain attachable after the
  // reversal (in-flight on-chain movements cannot be stopped here; the
  // attach/retry guards reject them against the clawed-back grant).
  for (const milestone of grant.milestones) {
    if (milestone.paymentIntentId !== null) {
      await abandonOpenIntent(deps, milestone.paymentIntentId);
    }
  }
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'grant_milestone_updated',
    actorUserId: input.actorUserId,
    details: { grant_id: grant.grantId, payout_state: 'clawed_back' },
    treasuryId: grant.treasuryId,
  });
  return { ok: true, grant: updated };
}
