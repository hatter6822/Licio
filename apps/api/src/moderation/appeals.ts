// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.3 appeals: eligibility check, submission, independent-reviewer
// assignment, and the overturn/uphold/modify decision + outcome (WS-J.2.4a /
// WS-J.1.3d).  Independence is enforced server-side at BOTH assignment (never
// the original decision-maker) and decision time (the original decision-maker
// can never act on the appeal).  Ownership is enforced: a user may only appeal
// their own action, and a non-owned action resolves to not-found (no oracle).
import {
  type AppealCreatedResponse,
  type AppealEligibilityView,
  appealEligibility,
  type ConsoleAction,
  type CreateAppealRequest,
  type EnforcementActionType,
  isDeEscalation,
  type ModerationReasonCode,
} from '@licio/shared';
import {
  ACCOUNT_ACTIONS,
  accountStateFor,
  actionReversible,
  CONTENT_ACTIONS,
  contentStateFor,
  performRevert,
} from './actions.js';
import { assignAppealReviewer } from './assignment.js';
import { writeAudit } from './audit.js';
import { isSenior, type StewardActor } from './authz.js';
import { createAppealOutcomeNotice } from './notices.js';
import type { ModerationServices } from './services.js';
import type { ModerationActionRecord, ModerationAppealRecord } from './stores.js';

/** Map a stored action verb to the appeal-matrix enforcement type. */
function enforcementTypeOf(action: string): EnforcementActionType | null {
  switch (action) {
    case 'warn':
    case 'hide':
    case 'remove':
    case 'restrict':
    case 'shadow':
    case 'suspend':
    case 'ban':
      return action;
    case 'emergency_restriction':
      return 'emergency_restriction';
    default:
      return null;
  }
}

/** Resolve eligibility for one of the requester's OWN actions (WS-J.1.3a). */
export async function checkEligibility(
  services: ModerationServices,
  actionId: string,
  userId: string,
): Promise<AppealEligibilityView | null> {
  const action = await services.actions.getById(actionId);
  if (!action || action.subjectUserId !== userId) return null; // not-found (no oracle)
  const enfType = enforcementTypeOf(action.action);
  if (enfType === null) return null;
  const cooldownHours = services.config().banAppealCooldownHours;
  const eligibility = appealEligibility(enfType, {
    ...(action.reasonCode ? { reasonCode: action.reasonCode as ModerationReasonCode } : {}),
    banCooldownHours: cooldownHours,
    shadowUserNotified: true,
  });
  const existing = await services.appeals.getByActionId(actionId);
  // Ban cooldown availability is measured from the action time.
  const availableAt =
    enfType === 'ban' && eligibility.availableAfterHours !== undefined
      ? new Date(
          Date.parse(action.createdAt) + eligibility.availableAfterHours * 3_600_000,
        ).toISOString()
      : null;
  const banCooldownActive = availableAt !== null && Date.parse(availableAt) > services.now();
  return {
    action_id: actionId,
    action_type: enfType,
    appealable: eligibility.appealable && !banCooldownActive,
    ineligible_reason: !eligibility.appealable
      ? (eligibility.ineligibleReason ?? null)
      : banCooldownActive
        ? 'ban_cooldown'
        : null,
    available_at: banCooldownActive ? availableAt : null,
    already_appealed: existing !== null,
  };
}

export type SubmitAppealOutcome =
  | { ok: true; response: AppealCreatedResponse }
  | { ok: false; code: 'action_not_found' }
  | { ok: false; code: 'action_not_appealable'; reason: string; availableAt: string | null }
  | { ok: false; code: 'appeal_already_exists'; appealId: string };

export async function submitAppeal(
  services: ModerationServices,
  appellantUserId: string,
  request: CreateAppealRequest,
): Promise<SubmitAppealOutcome> {
  const action = await services.actions.getById(request.action_id);
  if (!action || action.subjectUserId !== appellantUserId) {
    return { ok: false, code: 'action_not_found' };
  }
  const eligibility = await checkEligibility(services, request.action_id, appellantUserId);
  if (eligibility === null) return { ok: false, code: 'action_not_found' };
  if (eligibility.already_appealed) {
    const existing = await services.appeals.getByActionId(request.action_id);
    return { ok: false, code: 'appeal_already_exists', appealId: existing?.appealId ?? '' };
  }
  if (!eligibility.appealable) {
    return {
      ok: false,
      code: 'action_not_appealable',
      reason: eligibility.ineligible_reason ?? 'not_appealable',
      availableAt: eligibility.available_at,
    };
  }

  const isBanAppeal = action.action === 'ban';
  const slaHours = isBanAppeal
    ? services.config().appealSlaBanHours
    : services.config().appealSlaStandardHours;
  const slaDueAt = new Date(services.now() + slaHours * 3_600_000).toISOString();
  // Independent reviewer (never the original decision-maker; WS-J.1.3c).
  const assignedReviewerId = await assignAppealReviewer(services, action.actorUserId);

  let appeal: ModerationAppealRecord;
  try {
    appeal = await services.appeals.insert({
      actionId: request.action_id,
      appellantUserId,
      statement: request.user_statement,
      newEvidence: request.new_evidence ?? [],
      status: 'pending',
      assignedReviewerId,
      isBanAppeal,
      slaDueAt,
      decidedAt: null,
      decidedBy: null,
      decisionReasonCode: null,
      decisionExplanation: null,
    });
  } catch (error) {
    // Concurrent double-submit (double-click / offline retry): the
    // `moderation_appeals_action_uq` index rejects the loser — return the
    // documented duplicate response, not a 500.
    const existing = await services.appeals.getByActionId(request.action_id);
    if (existing) {
      return { ok: false, code: 'appeal_already_exists', appealId: existing.appealId };
    }
    throw error;
  }
  // Reflect the pending appeal onto the originating action notice so the inbox
  // stops offering an Appeal affordance that would now 409 (WS-J.1.3d).  The
  // persistent `appealable` flag never clears on its own.
  await services.notices.markAppealPending(appellantUserId, request.action_id);
  services.metrics.increment('appeals.created');
  return {
    ok: true,
    response: {
      appeal_id: appeal.appealId,
      status: 'pending',
      action_id: request.action_id,
      sla_due_at: slaDueAt,
      created_at: appeal.createdAt,
    },
  };
}

export type DecideAppealOutcome =
  | { ok: true; status: 'overturned' | 'upheld' | 'modified'; noticeSent: boolean }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'already_decided'
        | 'independence_violation'
        | 'insufficient_capability'
        | 'invalid_modification'
        | 'mfa_required';
      message: string;
    };

/**
 * Decide an appeal (WS-J.2.4a + WS-J.1.3d).  Independence is enforced: the
 * original decision-maker can never decide the appeal.  overturn reverts the
 * action; modify reverts then applies the new, less-severe action; uphold leaves
 * it.  All paths notify the user and audit the decision linked to the original.
 */
export async function decideAppeal(
  services: ModerationServices,
  actor: StewardActor,
  appealId: string,
  decision: 'overturn' | 'uphold' | 'modify',
  reasonCode: ModerationReasonCode,
  explanation: string,
  modifiedAction: ConsoleAction | undefined,
): Promise<DecideAppealOutcome> {
  const appeal = await services.appeals.getById(appealId);
  if (!appeal) return { ok: false, code: 'not_found', message: 'Appeal not found' };
  if (appeal.status !== 'pending') {
    return { ok: false, code: 'already_decided', message: 'Appeal already decided' };
  }
  const original = await services.actions.getById(appeal.actionId);
  if (!original) return { ok: false, code: 'not_found', message: 'Original action not found' };
  // Independence: the original decision-maker can NEVER act on the appeal.
  if (original.actorUserId !== null && original.actorUserId === actor.userId) {
    return { ok: false, code: 'independence_violation', message: 'Independent reviewer required' };
  }
  // A permanent-ban appeal is a senior-only decision (STEWARD_ROLES.md /
  // WS-A.1.2c: ban appeals are "ROLE_APPEALS (senior)"); the platform admin
  // carries the senior grant.  A non-senior appeals reviewer cannot decide it.
  if ((appeal.isBanAppeal || original.action === 'ban') && !isSenior(actor.platformRoles)) {
    return {
      ok: false,
      code: 'insufficient_capability',
      message: 'A ban appeal requires a senior appeals reviewer',
    };
  }
  // A `modify` may only DE-ESCALATE (WS-J.2.4a): the new action must be strictly
  // less severe than the original, so an appeal can never become a HARSHER
  // sanction (e.g. a warn/hide appeal modified into ban/suspend — escalation).
  if (decision === 'modify') {
    if (modifiedAction === undefined || !isDeEscalation(original.action, modifiedAction)) {
      return {
        ok: false,
        code: 'invalid_modification',
        message: 'A modified action must be strictly less severe than the original',
      };
    }
  }

  const status =
    decision === 'overturn' ? 'overturned' : decision === 'modify' ? 'modified' : 'upheld';
  const nowIso = new Date(services.now()).toISOString();

  if (decision === 'overturn' || decision === 'modify') {
    // Reverse the original (restores prior state, reversal integrity).  The
    // appeals reviewer's authority to overturn IS the authorization, so this
    // bypasses the steward-capability gate (an appeals reviewer need not hold
    // the original action's capability).  The lift is NOT gated on
    // `original.reversible`: that flag governs only the STEWARD self-revert
    // endpoint, not appeal authority — so a ban (recorded reversible:false,
    // un-toggleable by a steward) IS actually lifted when its appeal succeeds
    // (otherwise the appellant is told they won while the ban silently stands).
    if (!original.reverted) {
      await performRevert(services, actor, original);
    }
    if (decision === 'modify' && modifiedAction && original.subjectUserId) {
      await applyModifiedAction(services, actor, original, modifiedAction, reasonCode);
    }
  }

  await services.appeals.update(appealId, {
    status,
    decidedAt: nowIso,
    decidedBy: actor.userId,
    decisionReasonCode: reasonCode,
    decisionExplanation: explanation,
  });

  // Notify the appellant (WS-J.1.3d).
  await createAppealOutcomeNotice(services, {
    userId: appeal.appellantUserId,
    actionId: appeal.actionId,
    appealStatus: status,
    reasonCode,
    explanation,
  });

  await writeAudit(services, {
    actorUserId: actor.userId,
    actorRole: actor.stewardRoles[0] ?? null,
    action: 'appeal_decision',
    reasonCode,
    targetType: original.targetType,
    targetId: original.targetId,
    subjectUserId: appeal.appellantUserId,
    priorState: 'appeal_pending',
    nextState: status,
    reversible: false,
    linkedActionId: original.actionId,
    notes: explanation,
  });
  services.metrics.increment(`appeals.decided.${status}`);
  return { ok: true, status, noticeSent: true };
}

/**
 * Apply the new, less-severe action a `modify` outcome selects.  The prior
 * `performRevert` already restored the baseline (content visible / account
 * active), so the modified action is applied fresh and its FULL effect is
 * reflected to distribution via the same mapping as the action palette — a
 * downgrade like remove → hide or ban → restrict must actually leave the
 * content/account in the modified state, never silently fully restored.
 */
async function applyModifiedAction(
  services: ModerationServices,
  actor: StewardActor,
  original: ModerationActionRecord,
  modifiedAction: ConsoleAction,
  reasonCode: ModerationReasonCode,
): Promise<void> {
  const contentState =
    original.targetType === 'content' && CONTENT_ACTIONS.has(modifiedAction)
      ? contentStateFor(modifiedAction)
      : null;
  const accountState = ACCOUNT_ACTIONS.has(modifiedAction) ? accountStateFor(modifiedAction) : null;
  const priorState = contentState ? 'visible' : accountState ? 'active' : null;
  const nextState = contentState ?? accountState ?? null;
  const reversible = actionReversible(modifiedAction, reasonCode);
  const newAction = await services.actions.insert({
    actorUserId: actor.userId,
    actorRole: actor.stewardRoles[0] ?? null,
    action: modifiedAction,
    targetType: original.targetType,
    targetId: original.targetId,
    subjectUserId: original.subjectUserId,
    reasonCode,
    duration: null,
    reviewerNote: 'Applied via appeal modification',
    priorState,
    nextState,
    reversible,
    reverted: false,
    linkedActionId: original.actionId,
    caseId: original.caseId,
    coApproverUserId: null,
    reportIds: [],
  });
  if (contentState) {
    await services.content.applyContentState(
      original.targetId,
      null,
      contentState,
      original.caseId,
      actor.userId,
    );
  }
  if (accountState && original.subjectUserId) {
    await services.content.applyAccountState(original.subjectUserId, accountState, null);
  }
  await writeAudit(services, {
    actorUserId: actor.userId,
    actorRole: actor.stewardRoles[0] ?? null,
    action: modifiedAction,
    reasonCode,
    targetType: original.targetType,
    targetId: original.targetId,
    subjectUserId: original.subjectUserId,
    priorState,
    nextState,
    reversible,
    linkedActionId: newAction.actionId,
  });
}
