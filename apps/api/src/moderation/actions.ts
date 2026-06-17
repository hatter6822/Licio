// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.3 action palette + revert.  The SINGLE place a steward takes an
// enforcement action; it enforces the doctrine in code:
//   • capability-gated (server-side authorization, not UI-only);
//   • a reason code is required for every action;
//   • a SIGNIFICANT action generates a readable user notice (no silent sanction);
//   • the effect is reflected to distribution (content → hidden/removed; account
//     → restricted/suspended/banned) so removed content actually leaves feeds;
//   • every action emits a complete audit record (WS-J.2.5 fields);
//   • reversible actions revert with reversal integrity (WS-J.2.3b).
import {
  type AppealEligibility,
  appealEligibility,
  type ConsoleAction,
  type EnforcementActionType,
  isSignificantAction,
  type ModerationActionRequest,
  type ModerationActionResponse,
  type ModerationReasonCode,
  type RevertActionResponse,
  reasonCodeAppealable,
  type StewardCapability,
} from '@licio/shared';
import { writeAudit } from './audit.js';
import { denyCapability, isIntegrityActor, type StewardActor } from './authz.js';
import { createActionNotice } from './notices.js';
import type { AccountActionState, ContentVisibilityState } from './ports.js';
import type { ModerationServices } from './services.js';
import type { ModerationActionRecord } from './stores.js';

export type ActionOutcome =
  | { ok: true; response: ModerationActionResponse }
  | {
      ok: false;
      code: 'insufficient_capability' | 'mfa_required';
      message: string;
      requiredRole?: string;
    }
  | { ok: false; code: 'target_not_found'; message: string }
  | { ok: false; code: 'invalid_action_for_target'; message: string }
  | { ok: false; code: 'invalid_account_state'; message: string }
  | { ok: false; code: 'enforcement_delayed'; message: string };

/** Map a console action to the enforcement action type used by the appeal matrix
 *  (escalate/clear are workflow, not enforcement → null). */
function enforcementType(action: ConsoleAction): EnforcementActionType | null {
  switch (action) {
    case 'warn':
      return 'warn';
    case 'hide':
      return 'hide';
    case 'remove':
      return 'remove';
    case 'restrict':
      return 'restrict';
    case 'shadow':
      return 'shadow';
    case 'suspend':
      return 'suspend';
    case 'ban':
      return 'ban';
    default:
      return null;
  }
}

/** Parse a duration string ("7d"/"24h") to whole days; null when absent/invalid. */
export function parseDurationDays(duration: string | undefined): number | null {
  if (!duration) return null;
  const m = /^(\d{1,4})\s*(d|h)$/i.exec(duration.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2]?.toLowerCase() === 'h' ? Math.max(1, Math.round(n / 24)) : n;
}

/** Whether an action against content/account is steward-reversible. */
export function actionReversible(action: ConsoleAction, reasonCode: ModerationReasonCode): boolean {
  if (action === 'ban') return false; // permanent (appealable, but not revert-toggled)
  if (action === 'remove' && !reasonCodeAppealable(reasonCode)) return false; // lawful-basis (CSAM/threat)
  return true;
}

export const CONTENT_ACTIONS: ReadonlySet<ConsoleAction> = new Set(['hide', 'remove']);
export const ACCOUNT_ACTIONS: ReadonlySet<ConsoleAction> = new Set([
  'restrict',
  'shadow',
  'suspend',
  'ban',
]);

export function contentStateFor(action: ConsoleAction): ContentVisibilityState | null {
  if (action === 'hide') return 'hidden';
  if (action === 'remove') return 'removed';
  return null;
}

export function accountStateFor(action: ConsoleAction): AccountActionState | null {
  if (action === 'restrict') return 'restricted';
  if (action === 'suspend') return 'suspended';
  if (action === 'ban') return 'banned';
  return null; // shadow leaves account active (distribution reduced elsewhere)
}

/** Map a stored account `prior_state` (the account's state BEFORE the sanction)
 *  to the account action that restores it on revert/auto-lift.  `restricted`
 *  restores to restricted (not active — the user was already restricted before
 *  this sanction stacked on top); anything else (incl. a legacy `active`)
 *  restores to active. */
export function restoreStateFrom(priorState: string | null): AccountActionState {
  if (priorState === 'restricted') return 'restricted';
  if (priorState === 'suspended') return 'suspended';
  return 'active';
}

/** Whether a console action is valid for a case's target type — mirrors the
 *  `applyAction` guards: a content action (hide/remove) needs a content target;
 *  a room target accepts only workflow (escalate/clear, no enforcement verb); an
 *  account target accepts everything except content actions.  Used to scope the
 *  review palette so a reviewer is never offered an action that can only 400/409
 *  for the case in front of them. */
export function actionValidForTarget(
  action: ConsoleAction,
  targetType: 'content' | 'account' | 'room',
): boolean {
  if (targetType === 'room') return enforcementType(action) === null;
  if (targetType === 'account') return !CONTENT_ACTIONS.has(action);
  return true;
}

/**
 * Apply a moderation action.  `actor` is the authenticated steward (authorization
 * is resolved here, server-side); the route has zod-validated the request.
 */
export async function applyAction(
  services: ModerationServices,
  actor: StewardActor,
  request: ModerationActionRequest,
): Promise<ActionOutcome> {
  const denial = denyCapability(actor, request.action as StewardCapability);
  if (denial) {
    return { ok: false, code: denial.code, message: denial.message, requiredRole: 'ROLE_SAFETY' };
  }

  const reasonCode = request.reason_code as ModerationReasonCode;
  const resolution = await services.content.resolveTarget(request.target_type, request.target_id);
  if (!resolution.exists) {
    return { ok: false, code: 'target_not_found', message: 'Target not found' };
  }
  const subjectUserId =
    request.target_type === 'account' ? request.target_id : resolution.subjectUserId;

  // A content action (hide/remove) only makes sense on content.  On an
  // account/room target it would otherwise no-op (the content-state write is
  // skipped) yet still record the action and resolve the case — closing a report
  // with no enforcement effect.  Reject it instead.
  if (CONTENT_ACTIONS.has(request.action) && request.target_type !== 'content') {
    return {
      ok: false,
      code: 'invalid_action_for_target',
      message: `"${request.action}" can only be applied to content`,
    };
  }

  // A room case is actionable for WORKFLOW only (escalate/clear).  Room-level
  // enforcement is not implemented, so an enforcement verb on a room would
  // record + resolve the case with NO effect — reject it instead (room-steward
  // enforcement is a tracked WS-J residual).
  if (request.target_type === 'room' && enforcementType(request.action) !== null) {
    return {
      ok: false,
      code: 'invalid_action_for_target',
      message: 'Only escalate or clear can be applied to a room case',
    };
  }

  const enfType = enforcementType(request.action);
  // Workflow-only actions (escalate/clear) change no content/account state, so
  // the reversal-integrity path has nothing to restore — a `/actions/:id/revert`
  // on one would falsely report success while the case stays escalated/resolved.
  // Only enforcement actions are steward-reversible; the case workflow is undone
  // by re-reviewing the case, not by the action-revert endpoint.
  const reversible = enfType !== null && actionReversible(request.action, reasonCode);
  const durationDays = parseDurationDays(request.duration);

  // Resolve the linked case ONCE and trust it only when its target matches this
  // action's target — a stale/forged `case_id` for a DIFFERENT target must not
  // leak that case's report ids into this action's accountability record (paired
  // with the same target-match guard in resolveCaseForAction below).
  const linkedCase = request.case_id ? await services.cases.getById(request.case_id) : null;
  const caseMatches =
    linkedCase !== null &&
    linkedCase.targetType === request.target_type &&
    linkedCase.targetId === request.target_id;
  // The action/audit report list is the matching case's aggregated reports (the
  // console passes `case_id` but not the ids; the audit view exposes
  // `report_ids` but not `case_id`), so the resolved reports stay traceable.
  const reportIds =
    request.report_ids && request.report_ids.length > 0
      ? request.report_ids
      : linkedCase && caseMatches
        ? (await services.reports.listByCase(linkedCase.caseId)).map((r) => r.reportId)
        : [];

  // MFCI-2 (WS-J.2.6e): while a coordinated-report incident holds the case,
  // volume-driven enforcement is DELAYED pending integrity review — so a
  // brigade of false reports cannot drive an enforcement action against its
  // target.  An integrity analyst (ROLE_INTEGRITY) IS the review and may still
  // act; everyone else is held until the incident is cleared (which lifts the
  // flag).  Workflow-only actions (escalate/clear) are never blocked.
  if (enfType !== null && !isIntegrityActor(actor)) {
    // The hold is keyed on the TARGET's open case (authoritative), NOT a
    // client-supplied case_id — otherwise a steward could omit/forge case_id to
    // bypass the MFCI-2 protection.  An integrity analyst (ROLE_INTEGRITY) IS the
    // review and is exempt; everyone else is held until the incident clears.
    const openCase = await services.cases.findOpenByTarget(request.target_type, request.target_id);
    if (openCase?.enforcementDelayed) {
      services.metrics.increment('moderation.action.enforcement_delayed');
      return {
        ok: false,
        code: 'enforcement_delayed',
        message:
          'Enforcement is delayed pending integrity review of a coordinated-report incident.',
      };
    }
  }

  // 1. Record the action FIRST — a durable record before any enforcement side
  //    effect.  The ports span separate stores with no shared transaction, so
  //    insert-first is the outbox ordering: a failure AFTER the insert leaves
  //    "recorded, not enforced" (the distribution seam reads the item-safety /
  //    account state, NOT this row, so content stays visible and the row is a
  //    revert handle), never the unrecoverable "enforced, not recorded".
  const contentState = CONTENT_ACTIONS.has(request.action) ? contentStateFor(request.action) : null;
  const accountState = ACCOUNT_ACTIONS.has(request.action) ? accountStateFor(request.action) : null;
  // An account sanction (NOT shadow — its mapping is null) records the account's
  // CURRENT state as the action's prior-state, so a revert/auto-lift restores the
  // TRUE prior (e.g. `restricted`), not an unconditional `active`.  A sanction on
  // a self-deactivated/purged account is refused — a later revert must never
  // resurrect a tombstone.
  let priorAccount = 'active';
  if (accountState !== null && subjectUserId) {
    const current = await services.users.currentAccountState(subjectUserId);
    if (current === 'deactivated' || current === 'deleted') {
      return {
        ok: false,
        code: 'invalid_account_state',
        message: 'Cannot apply an account action to a deactivated or deleted account',
      };
    }
    priorAccount = current ?? 'active';
  }
  const priorState = contentState ? 'visible' : accountState ? priorAccount : null;
  const nextState = contentState ?? accountState ?? null;
  const action = await services.actions.insert({
    actorUserId: actor.userId,
    actorRole: actor.stewardRoles[0] ?? null,
    action: request.action,
    targetType: request.target_type,
    targetId: request.target_id,
    subjectUserId: subjectUserId ?? null,
    reasonCode,
    duration: request.duration ?? null,
    reviewerNote: request.reviewer_note ?? null,
    priorState,
    nextState,
    reversible,
    reverted: false,
    linkedActionId: null,
    caseId: request.case_id ?? null,
    coApproverUserId: null,
    reportIds,
  });

  // 2. Apply the effect (idempotent at the port; an already-removed item is a
  //    no-op there).  Reflected to distribution (the ranking seam).
  if (contentState && request.target_type === 'content') {
    await services.content.applyContentState(
      request.target_id,
      resolution.contentKind,
      contentState,
      request.case_id ?? null,
      actor.userId,
    );
  }
  if (accountState && subjectUserId) {
    await services.content.applyAccountState(subjectUserId, accountState, durationDays);
  }

  // 3. Resolve the linked case/reports.
  await resolveCaseForAction(services, request, action.actionId);

  // 4. Notice + appealability (significant actions only; never silent).
  let appealable = false;
  let noticeSent = false;
  if (enfType !== null) {
    const eligibility: AppealEligibility = appealEligibility(enfType, {
      reasonCode,
      banCooldownHours: services.config().banAppealCooldownHours,
      shadowUserNotified: true,
      emergencyReviewComplete: false,
    });
    // A ban is not appealable until its cooldown elapses; the notice must not
    // advertise an Appeal affordance that would be rejected (WS-J.1.3a) — it
    // carries the "appeal available after N hours" note instead.  `appealable`
    // reflects current availability, not eventual eligibility.
    appealable =
      eligibility.appealable && !(enfType === 'ban' && (eligibility.availableAfterHours ?? 0) > 0);
    if (isSignificantAction(enfType) && subjectUserId) {
      const banNote =
        enfType === 'ban' && eligibility.availableAfterHours
          ? `You may appeal this ban once, after ${eligibility.availableAfterHours} hours.`
          : null;
      await createActionNotice(services, {
        userId: subjectUserId,
        actionId: action.actionId,
        action: request.action,
        reasonCode,
        appealable,
        appealAvailableNote: banNote,
      });
      noticeSent = true;
    }
  }

  // 5. Audit (complete field set, WS-J.2.5a).
  await writeAudit(services, {
    actorUserId: actor.userId,
    actorRole: action.actorRole,
    action: request.action,
    reasonCode,
    targetType: request.target_type,
    targetId: request.target_id,
    subjectUserId: subjectUserId ?? null,
    priorState,
    nextState,
    reversible,
    reportIds,
    notes: request.reviewer_note ?? null,
  });
  services.metrics.increment(`moderation.action.${request.action}`);

  return {
    ok: true,
    response: {
      action_id: action.actionId,
      action: request.action,
      reversible,
      notice_sent: noticeSent,
      appealable,
      created_at: action.createdAt,
    },
  };
}

/** Move the action's case/reports to their resolved/escalated state. */
async function resolveCaseForAction(
  services: ModerationServices,
  request: ModerationActionRequest,
  actionId: string,
): Promise<void> {
  if (!request.case_id) return;
  const theCase = await services.cases.getById(request.case_id);
  if (!theCase) return;
  // The case_id must reference the SAME target this action enforced.  A stale or
  // forged case_id for a DIFFERENT target would otherwise resolve/escalate an
  // unrelated case (silently dropping it from the queue) while the enforcement
  // landed on request.target_id.  On mismatch the action still stands on its
  // own target; we simply do not touch the unrelated case.
  if (theCase.targetType !== request.target_type || theCase.targetId !== request.target_id) {
    return;
  }
  if (request.action === 'escalate') {
    await services.cases.update(theCase.caseId, { status: 'escalated' });
    return;
  }
  // clear (dismiss not-actionable) and all enforcement actions resolve the case.
  await services.cases.update(theCase.caseId, {
    status: 'resolved',
    resolvedActionId: request.action === 'clear' ? null : actionId,
  });
}

export type RevertOutcome =
  | { ok: true; response: RevertActionResponse }
  | {
      ok: false;
      code: 'not_found' | 'not_reversible' | 'insufficient_capability' | 'mfa_required';
      message: string;
    };

/**
 * Revert a reversible action (WS-J.2.3b): restore prior state, re-notify the
 * subject when the original carried a notice, and audit the revert linked to
 * the original.  Reversal integrity: a revert restores ONLY this item's prior
 * visibility — it never resurrects separately-removed content (the port acts
 * per-item) and the audit chain records the linkage.
 */
export async function revertAction(
  services: ModerationServices,
  actor: StewardActor,
  actionId: string,
): Promise<RevertOutcome> {
  const original = await services.actions.getById(actionId);
  if (!original) return { ok: false, code: 'not_found', message: 'Action not found' };
  if (!original.reversible) {
    return { ok: false, code: 'not_reversible', message: 'This action cannot be reverted' };
  }
  // A direct steward revert requires the original action's capability; an
  // appeal-driven revert (performRevert, below) is authorized by ROLE_APPEALS.
  const denial = denyCapability(actor, original.action as StewardCapability);
  if (denial) return { ok: false, code: denial.code, message: denial.message };

  if (original.reverted) {
    // Idempotent: already reverted → reflect the single restored state.
    return {
      ok: true,
      response: {
        revert_action_id: original.linkedActionId ?? original.actionId,
        reverted_action_id: original.actionId,
        notice_sent: false,
        created_at: new Date(services.now()).toISOString(),
      },
    };
  }
  return { ok: true, response: await performRevert(services, actor, original) };
}

/**
 * Restore prior state, mark the original reverted, record the linked revert
 * action, re-notify the subject, and audit — WITHOUT a capability check.  The
 * caller is responsible for authorization (a steward with the original
 * capability via {@link revertAction}, or a ROLE_APPEALS overturn/modify).
 */
export async function performRevert(
  services: ModerationServices,
  actor: StewardActor,
  original: ModerationActionRecord,
): Promise<RevertActionResponse> {
  // Reversal integrity (WS-J.2.3b): restore prior state ONLY when no OTHER
  // active enforcement action still holds the item/account down — a revert
  // never resurrects content that a separate, still-standing removal suppresses.
  // The state restore runs BEFORE marking the original reverted, so a transient
  // store failure leaves `reverted=false` and a retry re-attempts the restore
  // (rather than taking the idempotent path with the state still sanctioned).
  // Both scans EXCLUDE this action explicitly (by id) since it is not yet marked.
  if (CONTENT_ACTIONS.has(original.action as ConsoleAction) && original.targetType === 'content') {
    const stillSuppressed = (
      await services.actions.listActiveByTarget('content', original.targetId)
    ).some(
      (a) => a.actionId !== original.actionId && CONTENT_ACTIONS.has(a.action as ConsoleAction),
    );
    if (!stillSuppressed) {
      await services.content.applyContentState(
        original.targetId,
        null,
        'visible',
        original.caseId,
        actor.userId,
      );
    }
  }
  // Only actions that actually WRITE an account state gate the restore.  `shadow`
  // is an account action but maps to no WS-D state (accountStateFor → null), so a
  // standing shadow must NOT block restoring an expiring/reverted suspend/restrict
  // (its reach reduction is lifted by reverting the shadow itself, not here).
  if (accountStateFor(original.action as ConsoleAction) !== null && original.subjectUserId) {
    // Scan the SUBJECT's other active account sanctions BY SUBJECT, not by the
    // action's target: an account sanction taken from a CONTENT case has the
    // content as its target, so a target scan would miss the user's sanctions
    // from other reports and prematurely lift them.  This action is excluded by
    // id (it is not yet marked reverted), and `shadow` is excluded (no WS-D state).
    const stillRestricted = (await services.actions.listBySubject(original.subjectUserId)).some(
      (a) =>
        a.actionId !== original.actionId &&
        !a.reverted &&
        accountStateFor(a.action as ConsoleAction) !== null,
    );
    if (!stillRestricted) {
      // Restore the TRUE prior account state (e.g. `restricted` if the user was
      // already restricted before this sanction stacked), not an unconditional
      // `active` — and never a `deactivated`/`deleted` tombstone (applyAction
      // refuses to sanction those, so `priorState` is never one).
      await services.content.applyAccountState(
        original.subjectUserId,
        restoreStateFrom(original.priorState),
        null,
      );
    }
  }
  // Restore succeeded — NOW mark the original reverted (idempotency point).
  await services.actions.update(original.actionId, { reverted: true });
  const revert = await services.actions.insert({
    actorUserId: actor.userId,
    actorRole: actor.stewardRoles[0] ?? null,
    action: 'revert',
    targetType: original.targetType,
    targetId: original.targetId,
    subjectUserId: original.subjectUserId,
    reasonCode: original.reasonCode,
    duration: null,
    reviewerNote: null,
    priorState: original.nextState,
    nextState: original.priorState,
    reversible: false,
    reverted: false,
    linkedActionId: original.actionId,
    caseId: original.caseId,
    coApproverUserId: null,
    reportIds: [],
  });

  // Re-notify the subject if the original carried a notice (no silent undo).
  let noticeSent = false;
  if (original.subjectUserId && isSignificantAction(original.action)) {
    await services.notices.insert({
      userId: original.subjectUserId,
      kind: 'action',
      actionId: revert.actionId,
      title: 'A moderation action was reversed',
      body: `A previous moderation action on your ${original.targetType} was reversed. No further action is required.`,
      reasonCode: original.reasonCode,
      appealable: false,
      appealStatus: null,
      readAt: null,
    });
    noticeSent = true;
  }

  await writeAudit(services, {
    actorUserId: actor.userId,
    actorRole: revert.actorRole,
    action: 'revert',
    reasonCode: original.reasonCode,
    targetType: original.targetType,
    targetId: original.targetId,
    subjectUserId: original.subjectUserId,
    priorState: original.nextState,
    nextState: original.priorState,
    reversible: false,
    linkedActionId: original.actionId,
  });
  services.metrics.increment('moderation.revert');

  return {
    revert_action_id: revert.actionId,
    reverted_action_id: original.actionId,
    notice_sent: noticeSent,
    created_at: revert.createdAt,
  };
}
