// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.3 appeals: eligibility check, submission, independent-reviewer
// assignment, and the overturn/uphold/modify decision + outcome (WS-J.2.4a /
// WS-J.1.3d).  Independence is enforced server-side at BOTH assignment and
// decision time: neither the original decision-maker NOR the appellant/subject
// may be assigned or decide (self-decision is a separation-of-duties violation).
// Ownership is enforced: a user may only appeal their own action, and a non-owned
// action resolves to not-found (no oracle).
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
import { NO_KEY_WARNING, scanForKeyMaterial } from '../compliance/no-key-filter.js';
import {
  ACCOUNT_ACTIONS,
  accountStateFor,
  actionReversible,
  CONTENT_ACTIONS,
  contentStateFor,
  parseDurationDays,
  performRevert,
} from './actions.js';
import { assignAppealReviewer } from './assignment.js';
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
  | { ok: false; code: 'appeal_already_exists'; appealId: string }
  | { ok: false; code: 'key_material_blocked'; message: string };

export async function submitAppeal(
  services: ModerationServices,
  appellantUserId: string,
  request: CreateAppealRequest,
): Promise<SubmitAppealOutcome> {
  // AUTHORIZATION first: the action must exist and belong to the appellant.
  const action = await services.actions.getById(request.action_id);
  if (!action || action.subjectUserId !== appellantUserId) {
    return { ok: false, code: 'action_not_found' };
  }
  const eligibility = await checkEligibility(services, request.action_id, appellantUserId);
  if (eligibility === null) return { ok: false, code: 'action_not_found' };
  // REPLAY before the mint-only gates: an action already appealed returns its
  // existing appeal id.  A lost-response retry whose statement now trips the
  // key-material detector (a tuning change, or an appeal accepted before the
  // filter shipped) must recover its appeal, not be newly denied — no row is
  // stored either way (WS-N.2.3e gates a NEW row).
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
  // WS-N.2.3e — the no-private-key filter, the SAME gate the report edge runs,
  // now that a NEW appeal row is about to be inserted.  An appeal is the other
  // free-text lane into this queue and into reviewer views, so a user pasting a
  // seed phrase while appealing would put the secret exactly where the report
  // filter exists to keep it out of.  The matched value is DISCARDED — never
  // logged, stored, or echoed (§18.5).
  const scan = scanForKeyMaterial(request.user_statement);
  if (scan.detected) {
    services.metrics.increment('appeals.key_material_blocked');
    return { ok: false, code: 'key_material_blocked', message: scan.warning ?? NO_KEY_WARNING };
  }

  const isBanAppeal = action.action === 'ban';
  const slaHours = isBanAppeal
    ? services.config().appealSlaBanHours
    : services.config().appealSlaStandardHours;
  const slaDueAt = new Date(services.now() + slaHours * 3_600_000).toISOString();
  // Independent reviewer (never the original decision-maker; WS-J.1.3c).
  const assignedReviewerId = await assignAppealReviewer(services, [
    action.actorUserId,
    appellantUserId,
  ]);

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
  // Independence: neither the original decision-maker NOR the appellant/subject may
  // decide the appeal.  Self-decision is the most basic separation-of-duties
  // violation — a steward whose own content was sanctioned (by another steward, or
  // auto-blocked with actorUserId=null) must never clear their own sanction.
  if (appeal.appellantUserId === actor.userId) {
    return {
      ok: false,
      code: 'independence_violation',
      message: 'You cannot decide your own appeal',
    };
  }
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
    // The modified action must stay within the ORIGINAL action's DOMAIN: an
    // account sanction (ban/suspend/restrict/shadow) downgrades to another
    // account action (or `warn`); a content action (hide/remove) downgrades to
    // another content action (or `warn`).  Keyed on the original action KIND,
    // not targetType — an account sanction issued from a CONTENT case carries
    // `targetType: 'content'` (subject = the author), so a targetType check
    // would wrongly reject a legitimate ban→restrict downgrade.  Crossing
    // domains is rejected: `applyModifiedAction` would otherwise revert the
    // original yet write no replacement state (a no-enforcement modification).
    const origAccount = ACCOUNT_ACTIONS.has(original.action as ConsoleAction);
    const origContent = CONTENT_ACTIONS.has(original.action as ConsoleAction);
    if (
      (origAccount && CONTENT_ACTIONS.has(modifiedAction)) ||
      (origContent && ACCOUNT_ACTIONS.has(modifiedAction))
    ) {
      return {
        ok: false,
        code: 'invalid_modification',
        message: "The modified action does not match the original action's domain",
      };
    }
  }

  const status =
    decision === 'overturn' ? 'overturned' : decision === 'modify' ? 'modified' : 'upheld';
  const nowIso = new Date(services.now()).toISOString();

  // Atomically CLAIM the pending appeal BEFORE any irreversible side effect
  // (revert/modify/notice).  The `status !== 'pending'` read above is only a
  // fast-path: two independent reviewers can pass it concurrently, so this
  // compare-and-set on `status='pending'` is the real gate — the loser gets
  // `already_decided` and never double-reverts/re-notifies.  Trade-off: a crash
  // AFTER the claim but BEFORE the revert leaves the appeal decided with the
  // sanction still standing (recoverable by a steward revert); race-safety here
  // outranks that rare retry case.
  // ONE UNIT: the irreversible claim, the notice bookkeeping it implies, and the audit
  // record of the decision.
  //
  // `claimDecision` is a compare-and-set with NO retry path — once it lands the appeal is
  // no longer pending and every retry answers `already_decided` — so an audit written
  // afterwards had exactly one chance and no way to recover from missing it.  The
  // decision's record now commits with the decision.
  //
  // The reversal and any replacement sanction stay BELOW and outside: both reach WS-D/WS-G
  // ports, which no transaction spans, and both are separately audited actions in their
  // own right.
  const claimed = await services.transactor.run(async (tx) => {
    const won = await tx.appeals.claimDecision(appealId, {
      status,
      decidedAt: nowIso,
      decidedBy: actor.userId,
      decisionReasonCode: reasonCode,
      decisionExplanation: explanation,
    });
    if (!won) return false;
    // Clear the ORIGINAL action notice's pending-appeal flag → its final status, so the
    // inbox stops rendering "Appeal under review" after the decision (the outcome notice
    // is a SEPARATE record; the original would otherwise stay stale forever — WS-J.1.3d).
    await tx.notices.markAppealDecided(appeal.appellantUserId, appeal.actionId, status);
    // Notify the appellant (WS-J.1.3d).
    await createAppealOutcomeNotice(
      services,
      {
        userId: appeal.appellantUserId,
        actionId: appeal.actionId,
        appealStatus: status,
        reasonCode,
        explanation,
      },
      tx.notices,
    );
    await tx.audit({
      actorUserId: actor.userId,
      actorRole: actor.stewardRoles[0] ?? null,
      action: 'appeal_decision',
      caseId: original.caseId,
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
    return true;
  });
  if (!claimed) {
    return { ok: false, code: 'already_decided', message: 'Appeal already decided' };
  }

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
    // Apply the replacement ONLY when the original was actually active and we
    // just reverted it.  If the original had ALREADY been reverted while the
    // appeal was pending (another steward, auto-expiry), `performRevert` was
    // skipped above — applying a fresh sanction here would re-hide/re-restrict a
    // user/content that was already cleared.  Decide the appeal (status,
    // notice, audit) without re-sanctioning.
    if (decision === 'modify' && modifiedAction && original.subjectUserId && !original.reverted) {
      await applyModifiedAction(services, actor, original, modifiedAction, reasonCode);
    }
  }

  // (The decision, its notices and its audit row all committed in the unit above.)
  services.metrics.increment(`appeals.decided.${status}`);
  return { ok: true, status, noticeSent: true };
}

const DAY_MS = 86_400_000;

/** The original sanction's REMAINING bound (whole days, floored at 1 while time
 *  is left), or `null` for a permanent original.  A modified replacement carries
 *  this so it expires no later than the original would have — never indefinite,
 *  never harsher in wall-clock. */
function remainingDuration(original: ModerationActionRecord, nowMs: number): string | null {
  const days = parseDurationDays(original.duration ?? undefined);
  if (days === null) return null; // permanent original → permanent replacement
  const expiresAtMs = Date.parse(original.createdAt) + days * DAY_MS;
  return `${Math.max(1, Math.ceil((expiresAtMs - nowMs) / DAY_MS))}d`;
}

/**
 * Apply the new, less-severe action a `modify` outcome selects.  The prior
 * `performRevert` already restored the baseline (content visible / account to
 * its true prior state), so the modified action is applied fresh and its FULL
 * effect is reflected to distribution via the same mapping as the action
 * palette — a downgrade like remove → hide or ban → restrict must actually
 * leave the content/account in the modified state, never silently fully
 * restored.  It carries the original's prior state + remaining duration so a
 * later revert/expiry restores the right baseline on the original's schedule.
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
  // The replacement stacks on the baseline `performRevert` just restored — the
  // ORIGINAL action's prior account state (e.g. `restricted`/`suspended`), NOT
  // an unconditional `active`.  The domain guard above guarantees an account
  // replacement only follows an account original, so `original.priorState` is a
  // real account state.  Without this, reverting/expiring the replacement would
  // reactivate a user who was already sanctioned before the original action.
  const priorState = contentState
    ? 'visible'
    : accountState
      ? (original.priorState ?? 'active')
      : null;
  const nextState = contentState ?? accountState ?? null;
  const reversible = actionReversible(modifiedAction, reasonCode);
  // Carry the original's REMAINING duration onto an account replacement so the
  // scheduler still auto-lifts it (a `null` duration would make a downgraded
  // temporary sanction PERMANENT — harsher than the original).  Content
  // modifications carry no duration (auto-lift is account-only).
  const duration = accountState ? remainingDuration(original, services.now()) : null;
  // SAME RULE AS `applyAction`: nothing is recorded unless the effect landed.  A row
  // written before the ports and left behind by a failure reads as live suppression to
  // `performRevert`, which is how a phantom sanction defeats a later appeal — and this
  // function IS the appeal path, so it is the last place that should leave one.
  if (contentState && original.targetId !== null) {
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
  await services.transactor.run(async (tx) => {
    const newAction = await tx.actions.insert({
      actorUserId: actor.userId,
      actorRole: actor.stewardRoles[0] ?? null,
      action: modifiedAction,
      targetType: original.targetType,
      targetId: original.targetId,
      subjectUserId: original.subjectUserId,
      reasonCode,
      duration,
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
    await tx.audit({
      actorUserId: actor.userId,
      actorRole: actor.stewardRoles[0] ?? null,
      action: modifiedAction,
      caseId: original.caseId,
      reasonCode,
      targetType: original.targetType,
      targetId: original.targetId,
      subjectUserId: original.subjectUserId,
      priorState,
      nextState,
      reversible,
      linkedActionId: newAction.actionId,
    });
  });
}
