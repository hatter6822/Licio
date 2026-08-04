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
  OPEN_CASE_STATUSES,
  type RevertActionResponse,
  reasonCodeAppealable,
  type StewardCapability,
} from '@licio/shared';
import {
  type CapabilityDenial,
  denyCapability,
  isIntegrityActor,
  type StewardActor,
} from './authz.js';
import { createActionNotice } from './notices.js';
import type { AccountActionState, ContentVisibilityState } from './ports.js';
import type { ModerationServices } from './services.js';
import type {
  ModerationActionRecord,
  ModerationCaseRecord,
  ModerationCaseStore,
} from './stores.js';

export type ActionOutcome =
  | { ok: true; response: ModerationActionResponse }
  | {
      ok: false;
      // Derived from the denial type rather than re-listed: these codes are
      // decided in ONE place (`denyCapability`), and a hand-copied union goes
      // stale the moment a gate is added there.
      code: CapabilityDenial['code'];
      message: string;
      requiredRole?: string;
    }
  | { ok: false; code: 'target_not_found'; message: string }
  | { ok: false; code: 'invalid_action_for_target'; message: string }
  | { ok: false; code: 'invalid_account_state'; message: string }
  | { ok: false; code: 'enforcement_delayed'; message: string };

/** Map a console action to the enforcement action type used by the appeal matrix
 *  (escalate/clear are workflow, not enforcement → null). */
export function enforcementType(action: ConsoleAction): EnforcementActionType | null {
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
  //
  // ONE binding, not a predicate applied per consumer.  The match used to be a separate
  // boolean, and every consumer had to remember to consult it: the report list did, the
  // case resolution recomputed it from its own re-read, and the two `case_id` columns
  // did not — so an unmatched case still reached both the action row and the audit row,
  // the one place the comment claimed was verified.  A steward could file an action into
  // any case they could name, and the case-history panel would render it as that case's.
  // Non-null here MEANS matched, so there is nothing left to forget.
  const matchedCase = await matchCase(services, request);
  // The action/audit report list is the matching case's aggregated reports (the
  // console passes `case_id` but not the ids; the audit view exposes
  // `report_ids` but not `case_id`), so the resolved reports stay traceable.
  const caseReportIds = matchedCase
    ? (await services.reports.listByCase(matchedCase.caseId)).map((r) => r.reportId)
    : [];
  // Client-supplied `report_ids` are accountability claims — trust them ONLY
  // when they belong to the matched case.  A forged/stale id, or one from a
  // DIFFERENT case/target, must never enter this action's record: it would
  // claim to resolve reports the action never addressed while
  // `resolveCaseForAction` only touches the matched case.  With no matched case
  // there is nothing to validate against, so supplied ids are dropped and the
  // action's report list is empty (it still stands on its own target).
  const caseReportIdSet = new Set(caseReportIds);
  const reportIds =
    request.report_ids && request.report_ids.length > 0
      ? request.report_ids.filter((id) => caseReportIdSet.has(id))
      : caseReportIds;

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
    // The target-keyed check above covers a content case only when THIS action
    // hits the same content id.  An account action against the SUBJECT of a
    // content-target incident carries a different target_id, so also hold when
    // the subject has ANY open, enforcement-delayed case about them — a brigade
    // cannot be evaded by pivoting the client-supplied target_type to `account`.
    if (subjectUserId) {
      // An EXISTENCE check over the full open set — not a bounded `list` page: a
      // subject with more open cases than a page limit could otherwise carry the
      // enforcement-delayed coordinated-report case off-page and slip the pivot.
      const openDelayed = await services.cases.count({
        subjectUserId,
        status: OPEN_CASE_STATUSES,
        enforcementDelayed: true,
      });
      if (openDelayed > 0) {
        services.metrics.increment('moderation.action.enforcement_delayed');
        return {
          ok: false,
          code: 'enforcement_delayed',
          message:
            'Enforcement is delayed pending integrity review of a coordinated-report incident.',
        };
      }
    }
  }

  // 1. Work out what this action changes.  The record and the enforcement now commit
  //    TOGETHER (one unit, below), so neither has to come first: the ordering note that
  //    used to stand here — insert the row before the side effect, so a failure between
  //    them leaves "recorded, not enforced" rather than "enforced, not recorded" — was
  //    picking the less-bad half of a gap that no longer exists.
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
  // NOTHING IS RECORDED UNLESS THE EFFECT LANDED.
  //
  // The action row used to be written FIRST, on the reasoning that it is the revert
  // handle: `applyContentState` writes two tables, so a throw between them leaves content
  // partially hidden, and without an action id no steward can undo it (`clear` maps to no
  // content state, so the palette offers no restore).  The concern is real.  The handle is
  // not — it costs more than it buys.
  //
  // `performRevert` asks `listActiveByTarget` whether some OTHER action still suppresses
  // the item, and skips restoring visibility when one does.  A row from an enforcement
  // that FAILED answers yes.  So a member whose content is removed, whose steward hits a
  // port failure and retries successfully, and who then WINS THEIR APPEAL, stays hidden —
  // defeated by the record of an attempt that never took effect.  The same row shows in
  // the reviewer's history panel as a standing sanction.  An orphan that enforces is not
  // a handle; it is a phantom sanction, and the safe thing is not to write one.
  //
  // A port failure now leaves at most a partial ranking-exclusion and no record at all.
  // That is UNDER-enforcement — the safe direction, nothing wrongly removed — and the
  // steward's retry completes it, the port being idempotent.  Closing even that means
  // making the port's own two writes atomic with each other, which belongs inside the
  // content port rather than here.
  //
  // ONE UNIT — THE ENFORCEMENT INCLUDED.
  //
  // The effect and every artifact that records it now commit together.  That is possible
  // because the enforcement writes reach WS-E item-safety state, WS-G contributions,
  // WS-F stories and WS-D accounts, and all four are the same Postgres: `tx.content` is
  // the same port bound to this transaction, supplied by the composition root.
  //
  // It removes the last two failure states rather than choosing between them.  A port
  // that throws part-way no longer leaves content partially hidden — the rollback takes
  // the safety-state write with it — so there is no orphaned suppression to recover from
  // and no need for the phantom "revert handle" that used to defeat appeals.  And a
  // record that fails no longer leaves an enforced action unrecorded, because the
  // enforcement goes back with it.
  //
  // The effect stays FIRST inside the unit: the ports are idempotent, and ordering them
  // ahead of the record keeps the trail's claim behind the thing it claims even while
  // both are provisional.
  let appealable = false;
  let noticeSent = false;
  const action = await services.transactor.run(async (tx) => {
    // Idempotent at the port; an already-removed item is a no-op there.  Reflected to
    // distribution through the ranking seam.
    if (contentState && request.target_type === 'content') {
      await tx.content.applyContentState(
        request.target_id,
        resolution.contentKind,
        contentState,
        request.case_id ?? null,
        actor.userId,
      );
    }
    if (accountState && subjectUserId) {
      await tx.content.applyAccountState(subjectUserId, accountState, durationDays);
    }

    const inserted = await tx.actions.insert({
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
      caseId: matchedCase?.caseId ?? null,
      coApproverUserId: null,
      reportIds,
    });

    await resolveCaseForAction(matchedCase, request.action, inserted.actionId, tx.cases);

    // The member notice (significant actions only; never silent).  A DURABLE row, so it
    // belongs here: a rolled-back record must not leave the member holding a statement of
    // reasons the trail does not show.
    if (enfType !== null) {
      const eligibility: AppealEligibility = appealEligibility(enfType, {
        reasonCode,
        banCooldownHours: services.config().banAppealCooldownHours,
        shadowUserNotified: true,
        emergencyReviewComplete: false,
      });
      // A ban is not appealable until its cooldown elapses; the notice must not advertise
      // an Appeal affordance that would be rejected (WS-J.1.3a) — it carries the "appeal
      // available after N hours" note instead.  `appealable` reflects current
      // availability, not eventual eligibility.
      appealable =
        eligibility.appealable &&
        !(enfType === 'ban' && (eligibility.availableAfterHours ?? 0) > 0);
      if (isSignificantAction(enfType) && subjectUserId) {
        const banNote =
          enfType === 'ban' && eligibility.availableAfterHours
            ? `You may appeal this ban once, after ${eligibility.availableAfterHours} hours.`
            : null;
        await createActionNotice(
          services,
          {
            userId: subjectUserId,
            actionId: inserted.actionId,
            action: request.action,
            reasonCode,
            appealable,
            appealAvailableNote: banNote,
          },
          tx.notices,
        );
        noticeSent = true;
      }
    }

    await tx.audit({
      actorUserId: actor.userId,
      actorRole: inserted.actorRole,
      action: request.action,
      // The MATCHED case, never the client's `request.case_id` — the same value the
      // action row was written with, so the history cannot be steered onto another case
      // by a forged or stale field.
      caseId: matchedCase?.caseId ?? null,
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
    return inserted;
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
/** Resolve or escalate the case this action was taken on.
 *
 *  Takes the MATCHED case rather than the request's id: the target-match check lives in
 *  `matchCase` and is discharged by the type here, so this cannot drift from the check
 *  the two `case_id` columns were written under — which is what happened when it
 *  re-read and re-checked for itself. */
async function resolveCaseForAction(
  matchedCase: ModerationCaseRecord | null,
  action: ModerationActionRequest['action'],
  actionId: string,
  /** The case store to write through — a unit's, so the case resolution commits with
   *  the action that performed it. */
  cases: ModerationCaseStore,
): Promise<void> {
  if (matchedCase === null) return;
  if (action === 'escalate') {
    await cases.update(matchedCase.caseId, { status: 'escalated' });
    return;
  }
  // clear (dismiss not-actionable) and all enforcement actions resolve the case.
  await cases.update(matchedCase.caseId, {
    status: 'resolved',
    resolvedActionId: action === 'clear' ? null : actionId,
  });
}

/** The case named by `case_id`, but ONLY when it is about the same target this action
 *  enforces on.
 *
 *  A stale or forged id for a DIFFERENT target must not resolve that case (silently
 *  dropping someone else's report from the queue), leak its report ids into this
 *  action's accountability record, or file this action into its history.  On a mismatch
 *  the action still stands on its own target — it simply carries no case — and the
 *  mismatch is METERED, because a console that keeps sending one is sending its
 *  reviewers' resolutions nowhere and nothing else would say so. */
async function matchCase(
  services: ModerationServices,
  request: ModerationActionRequest,
): Promise<ModerationCaseRecord | null> {
  if (!request.case_id) return null;
  const theCase = await services.cases.getById(request.case_id);
  if (!theCase) {
    services.metrics.increment('moderation.action.case_unknown');
    return null;
  }
  if (theCase.targetType !== request.target_type || theCase.targetId !== request.target_id) {
    services.metrics.increment('moderation.action.case_target_mismatch');
    return null;
  }
  return theCase;
}

/** The scope a revert must be serialised within — the set its reversal-integrity scan
 *  reads.  Content actions scan BY TARGET, account sanctions BY SUBJECT; anything else
 *  scans nothing and only needs to not collide, so it takes its own action's scope. */
function revertScopeKey(original: ModerationActionRecord): string {
  if (
    CONTENT_ACTIONS.has(original.action as ConsoleAction) &&
    original.targetType === 'content' &&
    original.targetId !== null
  ) {
    return `content:${original.targetId}`;
  }
  if (accountStateFor(original.action as ConsoleAction) !== null && original.subjectUserId) {
    return `account:${original.subjectUserId}`;
  }
  return `action:${original.actionId}`;
}

export type RevertOutcome =
  | { ok: true; response: RevertActionResponse }
  | {
      ok: false;
      code: 'not_found' | 'not_reversible' | CapabilityDenial['code'];
      message: string;
    };

/**
 * Revert a reversible action (WS-J.2.3b): restore prior state, re-notify the
 * subject when the original carried a notice, and audit the revert linked to
 * the original.  Reversal integrity: a revert restores ONLY this item's prior
 * visibility — it never resurrects separately-removed content (the port acts
 * per-item) and the audit chain records the linkage.
 */
/** The steward's accountability for THIS revert — distinct from the original
 *  action's reason.  Recorded on the revert action + audit so the trail reflects
 *  WHY the action was reverted (e.g. "issued in error"), not the old violation. */
export interface RevertContext {
  reasonCode?: ModerationReasonCode;
  reviewerNote?: string | null;
}

export async function revertAction(
  services: ModerationServices,
  actor: StewardActor,
  actionId: string,
  context: RevertContext = {},
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
  return { ok: true, response: await performRevert(services, actor, original, context) };
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
  context: RevertContext = {},
): Promise<RevertActionResponse> {
  // The revert's OWN accountability: the steward's submitted reason/note when
  // present (a direct `/revert` carries `reason_code`), else the original
  // action's reason (an appeal-driven revert inherits its context).
  const revertReason = context.reasonCode ?? original.reasonCode;
  const revertNote = context.reviewerNote ?? null;
  // REVERSAL INTEGRITY, INSIDE THE UNIT AND BEHIND A SCOPE LOCK.
  //
  // The scans below ask "is any OTHER sanction still holding this down?" and skip the
  // restore when one is.  Run before the unit, they read a snapshot taken before this
  // revert's compare-and-set — and two reverts of DIFFERENT actions never contend, since
  // each marks only its own row.  So each saw the other still active, each deferred, and
  // the subject was left sanctioned with nothing active to revert: `listActive…` filters
  // on `reverted = false`, so the expiry sweep never revisits it, and a retried revert
  // takes the idempotent path without restoring.  Permanently suspended, no way back.
  //
  // The compare-and-set cannot fix that by itself, which is why the lock is here: it
  // serialises the units that share a subject, so the second one's scan sees the first's
  // reversal committed and performs the restore.  The LAST reverter restores, which is
  // the intended rule.
  //
  // The restores moved inside with the scans, so the ordering note they used to carry —
  // restore first, mark second, so a failure leaves a retryable state — is obsolete:
  // there is no longer an interval between them for a failure to land in.
  const claimed = await services.transactor.run(async (tx) => {
    // Serialise against the other reverts whose scan reads the SAME set as this one's.
    // The key follows the scan rather than the record: the content scan is by target and
    // the account scan is by subject, so keying both on `subjectUserId ?? targetId` would
    // put two content reverts on one target into DIFFERENT scopes whenever their subjects
    // differ — which they do once an erasure scrub NULLs one author.  Both would then
    // scan concurrently, both defer, and the content stays suppressed with nothing active
    // to revert, which is the defect this lock exists to prevent.
    //
    // At most one branch below applies (`CONTENT_ACTIONS` and the account-state actions
    // are disjoint), so this is one lock, not two.  Taken FIRST: scope → rows → chain.
    await tx.lockRevertScope(revertScopeKey(original));
    const marked = await tx.actions.revertIfNotReverted(original.actionId);
    // Someone else reverted it between the read above and here.  Nothing written, so the
    // empty unit commits and the caller answers idempotently rather than recording a
    // second reversal of the same action.
    if (marked === null) return null;

    // Reversal integrity (WS-J.2.3b): restore prior state ONLY when no OTHER
    // active enforcement action still holds the item/account down — a revert
    // never resurrects content that a separate, still-standing removal suppresses.
    // A failure here rolls the claim back with it, so `reverted` returns to false and a
    // retry re-attempts the restore rather than taking the idempotent path with the
    // state still sanctioned.  That is what the old restore-then-mark ordering was
    // reaching for without a transaction to get it.
    // Neither scan needs to exclude this action any more: the compare-and-set above
    // already marked it, so `listActiveByTarget` no longer returns it and the
    // `!a.reverted` filter drops it — but both still exclude it by id, because that
    // holds whether or not the claim precedes the scan.
    // `targetId` is null only for an erased `account` target; a content action's
    // target is never scrubbed, so the guard also narrows the type.
    if (
      CONTENT_ACTIONS.has(original.action as ConsoleAction) &&
      original.targetType === 'content' &&
      original.targetId !== null
    ) {
      const stillSuppressed = (
        await tx.actions.listActiveByTarget('content', original.targetId)
      ).some(
        (a) => a.actionId !== original.actionId && CONTENT_ACTIONS.has(a.action as ConsoleAction),
      );
      if (!stillSuppressed) {
        await tx.content.applyContentState(
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
      const stillRestricted = (await tx.actions.listBySubject(original.subjectUserId)).some(
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
        await tx.content.applyAccountState(
          original.subjectUserId,
          restoreStateFrom(original.priorState),
          null,
        );
      }
    }
    // The reversal is already claimed above and the state already restored; what remains
    // is the record of it: the `revert` action row, the member notice, and the audit
    // entry.  The compare-and-set is what makes a reversal happen once — it replaced a
    // blind `update` guarded by a read taken far above, under which two concurrent
    // reverts both passed the check, both wrote, and the trail recorded one reversal
    // twice.
    const revert = await tx.actions.insert({
      actorUserId: actor.userId,
      actorRole: actor.stewardRoles[0] ?? null,
      action: 'revert',
      targetType: original.targetType,
      targetId: original.targetId,
      subjectUserId: original.subjectUserId,
      reasonCode: revertReason,
      duration: null,
      reviewerNote: revertNote,
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
      await tx.notices.insert({
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

    await tx.audit({
      actorUserId: actor.userId,
      actorRole: revert.actorRole,
      action: 'revert',
      // The REVERTED action's case, so a revert lands in the history of the case that
      // produced it rather than nowhere.
      caseId: original.caseId,
      reasonCode: revertReason,
      targetType: original.targetType,
      targetId: original.targetId,
      subjectUserId: original.subjectUserId,
      priorState: original.nextState,
      nextState: original.priorState,
      reversible: false,
      linkedActionId: original.actionId,
      notes: revertNote,
    });
    return { revert, noticeSent };
  });

  if (claimed === null) {
    // The idempotent answer, matching the shape the early `original.reverted` check
    // returns — a retried request must not become a conflict, and a lost race IS a retry.
    return {
      revert_action_id: original.linkedActionId ?? original.actionId,
      reverted_action_id: original.actionId,
      notice_sent: false,
      created_at: new Date(services.now()).toISOString(),
    };
  }
  const { revert, noticeSent } = claimed;
  services.metrics.increment('moderation.revert');

  return {
    revert_action_id: revert.actionId,
    reverted_action_id: original.actionId,
    notice_sent: noticeSent,
    created_at: revert.createdAt,
  };
}
