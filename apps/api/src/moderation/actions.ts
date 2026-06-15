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
import { denyCapability, type StewardActor } from './authz.js';
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
  | { ok: false; code: 'target_not_found'; message: string };

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

const CONTENT_ACTIONS: ReadonlySet<ConsoleAction> = new Set(['hide', 'remove']);
const ACCOUNT_ACTIONS: ReadonlySet<ConsoleAction> = new Set([
  'restrict',
  'shadow',
  'suspend',
  'ban',
]);

function contentStateFor(action: ConsoleAction): ContentVisibilityState | null {
  if (action === 'hide') return 'hidden';
  if (action === 'remove') return 'removed';
  return null;
}

function accountStateFor(action: ConsoleAction): AccountActionState | null {
  if (action === 'restrict') return 'restricted';
  if (action === 'suspend') return 'suspended';
  if (action === 'ban') return 'banned';
  return null; // shadow leaves account active (distribution reduced elsewhere)
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

  const enfType = enforcementType(request.action);
  const reversible = actionReversible(request.action, reasonCode);
  const durationDays = parseDurationDays(request.duration);

  // 1. Apply the effect (idempotent at the port; an already-removed item is a
  //    no-op there).  Reflected to distribution (the ranking seam).
  const contentState = CONTENT_ACTIONS.has(request.action) ? contentStateFor(request.action) : null;
  if (contentState && request.target_type === 'content') {
    await services.content.applyContentState(
      request.target_id,
      resolution.contentKind,
      contentState,
      request.case_id ?? null,
      actor.userId,
    );
  }
  const accountState = ACCOUNT_ACTIONS.has(request.action) ? accountStateFor(request.action) : null;
  if (accountState && subjectUserId) {
    await services.content.applyAccountState(subjectUserId, accountState, durationDays);
  }

  // 2. Record the action.
  const priorState = contentState ? 'visible' : accountState ? 'active' : null;
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
    reportIds: request.report_ids ?? [],
  });

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
    appealable = eligibility.appealable;
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
    reportIds: request.report_ids ?? [],
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
  // Restore prior state.
  if (CONTENT_ACTIONS.has(original.action as ConsoleAction) && original.targetType === 'content') {
    await services.content.applyContentState(
      original.targetId,
      null,
      'visible',
      original.caseId,
      actor.userId,
    );
  }
  if (ACCOUNT_ACTIONS.has(original.action as ConsoleAction) && original.subjectUserId) {
    await services.content.applyAccountState(original.subjectUserId, 'active', null);
  }

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
