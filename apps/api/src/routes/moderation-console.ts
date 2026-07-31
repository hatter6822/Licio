// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2 moderation console routes (SPEC §18.2/§18.3, §16.4, §25.4): the report
// queue + filters + bulk + assignment (WS-J.2.1), the full-context review panel
// (WS-J.2.2), the action palette + revert (WS-J.2.3), the appeal review
// interface (WS-J.2.4), and the audit viewer + transparency export (WS-J.2.5).
// Every view/action is authorized by doctrine steward role + verified MFA, and
// the reads/exports are themselves audited.  Financial data never appears.

import {
  appealDecisionRequestSchema,
  appealDecisionResponseSchema,
  appealQueueResponseSchema,
  appealReviewResponseSchema,
  assignCaseRequestSchema,
  auditExportResponseSchema,
  auditListResponseSchema,
  auditQuerySchema,
  bulkActionRequestSchema,
  bulkActionResponseSchema,
  type ConsoleAction,
  caseReviewResponseSchema,
  evidenceDecisionRequestSchema,
  evidenceDecisionsResponseSchema,
  evidenceDecisionViewSchema,
  evidenceQueueResponseSchema,
  incidentQueueResponseSchema,
  incidentResolveRequestSchema,
  incidentResolveResponseSchema,
  type ModerationReasonCode,
  moderationActionRequestSchema,
  moderationActionResponseSchema,
  okResponseSchema,
  reportQueueFilterSchema,
  reportQueueResponseSchema,
  revertActionRequestSchema,
  revertActionResponseSchema,
  reviewerStatusRequestSchema,
  reviewerStatusResponseSchema,
  stewardRolesCanAccessQueue,
  urlVerdictRequestSchema,
  urlVerdictResponseSchema,
  uuidSchema,
} from '@licio/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { getIdentityServices } from '../identity/services.js';
import { decodeKeysetCursor, isCursorUuid } from '../lib/keyset-cursor.js';
import { zValidator } from '../lib/validate.js';
import { type AuthEnv, authMiddleware, getAuth } from '../middleware/auth.js';
import { applyAction, revertAction } from '../moderation/actions.js';
import { decideAppeal } from '../moderation/appeals.js';
import { auditToView, buildTransparencyExport, writeAudit } from '../moderation/audit.js';
import {
  denyQueue,
  effectiveStewardRoles,
  isStewardActor,
  mayseeReporterIdentity,
  type StewardActor,
} from '../moderation/authz.js';
import {
  MODERATION_CONFIG_KEYS,
  storeModerationConfigValue,
  validateModerationConfigValue,
} from '../moderation/config.js';
import {
  applyEvidenceDecision,
  buildEvidenceQueue,
  decisionToView,
} from '../moderation/evidence.js';
import { buildIncidentQueue, resolveIncident } from '../moderation/incidents.js';
import {
  buildAppealQueue,
  buildAppealReview,
  buildCaseReview,
  buildReportQueue,
} from '../moderation/review.js';
import { getModerationServices } from '../moderation/services.js';
import type { ModerationTx } from '../moderation/transactor.js';

const deny = (code: string, message: string) => ({ error: { code, message } });

/** The `(timestamp, uuid)` keyset cursor as a tuple, for the store filters that take
 *  the two parts separately.  Malformed cursors restart from the beginning. */
function decodeKeysetTuple(cursor: string | undefined): [string, string] | [undefined, undefined] {
  const at = decodeKeysetCursor(cursor);
  return at === null ? [undefined, undefined] : [at.time, at.id];
}

/** The audit cursor is the append ORDINAL — an integer, so it survives the wire round
 *  trip exactly.  A timestamp cannot: the driver truncates `timestamptz` to a
 *  millisecond `Date`, so the encoded value named a position BELOW the row it came
 *  from and the next page dropped the remainder of that millisecond (migration 0115). */
const encodeAuditCursor = (ordinal: number): string =>
  Buffer.from(`o|${ordinal}`, 'utf-8').toString('base64url');

/** Decode an audit cursor into the store filter fragment.  Accepts BOTH the ordinal
 *  form and the legacy `timestamp|uuid` form, so a console page opened before this
 *  deploy still pages correctly — the legacy id is exact, and the store resolves that
 *  row's own ordinal from it.  A malformed cursor restarts from the head (defensive:
 *  never a 500 from a failed cast inside a store). */
function decodeAuditCursor(
  cursor: string | undefined,
): { afterOrdinal: number } | { afterAuditId: string } | Record<string, never> {
  if (!cursor) return {};
  const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
  if (raw.startsWith('o|')) {
    const ordinal = Number(raw.slice(2));
    return Number.isSafeInteger(ordinal) && ordinal > 0 ? { afterOrdinal: ordinal } : {};
  }
  // The legacy form's id is exact, so the timestamp beside it does not have to parse —
  // only the id is used.  `decodeKeysetCursor` requires both, so this checks the id
  // directly rather than discarding a usable cursor.
  const [, id] = raw.split('|');
  return id !== undefined && isCursorUuid(id) ? { afterAuditId: id } : {};
}
const uuidParam = <K extends string>(name: K) =>
  z.object({ [name]: uuidSchema } as Record<K, typeof uuidSchema>);

/** Build the steward actor from the auth context. */
function actorOf(auth: NonNullable<ReturnType<typeof getAuth>>): StewardActor {
  return {
    userId: auth.userId,
    platformRoles: auth.roles,
    stewardRoles: auth.stewardRoles,
    mfaActive: auth.mfaActive,
    mfaVerified: auth.mfaVerified,
  };
}

/** Read the actor after `requireConsole` (which guarantees an authed steward). */
function mustActor(c: Context<AuthEnv>): StewardActor {
  const auth = getAuth(c);
  if (!auth) throw new Error('unreachable: requireConsole guarantees authentication');
  return actorOf(auth);
}

/** Authz denials (mfa_required + insufficient_capability) are both 403. */
const DENIAL_STATUS = 403 as const;

/** Audit/transparency read is for moderation/appeals/integrity roles (not an
 *  evidence-only steward). */
function auditReadAllowed(actor: StewardActor): boolean {
  return (['report-queue', 'appeal-queue', 'integrity-queue'] as const).some(
    (queue) => denyQueue(actor, queue) === null,
  );
}

/** Runtime-config access (read + write) is restricted to the abuse-enforcement
 *  roles — report-queue (ROLE_COMMUNITY/ROLE_SAFETY) or integrity-queue
 *  (ROLE_INTEGRITY).  An evidence-only or appeals-only steward must not read or
 *  tune rate limits, spam thresholds, or the malware-domain denylist. */
function configAccessAllowed(actor: StewardActor): boolean {
  return (['report-queue', 'integrity-queue'] as const).some(
    (queue) => denyQueue(actor, queue) === null,
  );
}

/** Compact, identity-free description of an audit query's scope (for the
 *  meta-audit record on a successful read). */
function auditQueryScope(q: {
  actor_id?: string | undefined;
  target_user?: string | undefined;
  action?: string | undefined;
  reason_code?: string | undefined;
  created_after?: string | undefined;
  created_before?: string | undefined;
  limit?: number | undefined;
}): string {
  const parts: string[] = [];
  if (q.actor_id) parts.push(`actor=${q.actor_id}`);
  if (q.target_user) parts.push(`subject=${q.target_user}`);
  if (q.action) parts.push(`action=${q.action}`);
  if (q.reason_code) parts.push(`reason=${q.reason_code}`);
  if (q.created_after) parts.push(`after=${q.created_after}`);
  if (q.created_before) parts.push(`before=${q.created_before}`);
  if (q.limit !== undefined) parts.push(`limit=${q.limit}`);
  return parts.length > 0 ? parts.join(' ') : 'unfiltered';
}

export function createModerationConsoleRoutes() {
  // Gate: authenticated + verified MFA + holds ≥1 doctrine steward role.
  const requireConsole: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const auth = getAuth(c);
    if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
    // AUTHORIZATION FIRST, then the session step-up.  The console is a fixed
    // surface rather than a per-resource lookup, so answering "you hold no
    // steward role" leaks nothing — while asking for MFA first told a
    // NON-STEWARD to verify for access they can never be granted, and handed
    // the UI a code it could only render as an authenticator form.
    if (!isStewardActor(actorOf(auth))) {
      return c.json(deny('forbidden', 'Steward role required'), 403);
    }
    // ENROLMENT and VERIFICATION are different problems with different repairs,
    // and one code for both left a steward who has never enrolled staring at a
    // form asking for a code no authenticator is generating.
    if (!auth.mfaActive) {
      return c.json(
        deny('mfa_enrollment_required', 'Enrol MFA to use the moderation console'),
        403,
      );
    }
    if (!auth.mfaVerified) {
      return c.json(deny('mfa_required', 'Verify MFA to use the moderation console'), 403);
    }
    await next();
    return;
  };

  return (
    new Hono<AuthEnv>()
      .use('*', authMiddleware())
      .use('*', requireConsole)

      // --- Report queue (WS-J.2.1a/b) -------------------------------------
      .get('/queue', zValidator('query', reportQueueFilterSchema), async (c) => {
        const actor = mustActor(c);
        const queueDenial = denyQueue(actor, 'report-queue');
        if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), DENIAL_STATUS);
        const f = c.req.valid('query');
        const result = await buildReportQueue(getModerationServices(), actor, {
          ...(f.severity ? { severity: f.severity } : {}),
          ...(f.status ? { status: f.status } : {}),
          ...(f.assignment ? { assignment: f.assignment } : {}),
          ...(f.assignee_id ? { assigneeId: f.assignee_id } : {}),
          ...(f.target_user ? { targetUser: f.target_user } : {}),
          ...(f.category && f.category.length > 0 ? { category: f.category } : {}),
          // The `reporter` filter exposes reporter identity, so it is honored
          // ONLY for roles permitted to see it (ROLE_SAFETY / ROLE_INTEGRITY);
          // for anyone else it is silently dropped (not applied).
          ...(f.reporter && mayseeReporterIdentity(actor) ? { reporter: f.reporter } : {}),
          ...(f.created_after ? { createdAfter: f.created_after } : {}),
          ...(f.created_before ? { createdBefore: f.created_before } : {}),
          ...(f.cursor ? { cursor: f.cursor } : {}),
          limit: f.limit ?? 50,
        });
        return c.json(reportQueueResponseSchema.parse(result));
      })

      // --- Full-context review panel (WS-J.2.2) ---------------------------
      .get('/cases/:caseId', zValidator('param', uuidParam('caseId')), async (c) => {
        const actor = mustActor(c);
        const queueDenial = denyQueue(actor, 'report-queue');
        if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
        const { caseId } = c.req.valid('param');
        const review = await buildCaseReview(getModerationServices(), actor, caseId);
        if (!review) return c.json(deny('not_found', 'Case not found'), 404);
        return c.json(caseReviewResponseSchema.parse(review));
      })

      // --- WS-J.2.6b reviewer link-opening malware check -------------------
      // Evidence URLs are stored, never fetched at submission time (§18.3 SSRF
      // posture); a reviewer resolves the redirect-chain verdict HERE before
      // navigating.  Same access gate as the panels the links render in: the
      // report-queue review panel AND the evidence queue (ROLE_EVIDENCE opens
      // citations, STEWARD_ROLES.md "verify source provenance").  An unwired
      // verdict seam reports `unavailable` — fail toward flagging, never
      // trusting.
      .post('/url-verdict', zValidator('json', urlVerdictRequestSchema), async (c) => {
        const actor = mustActor(c);
        const queueDenial = denyQueue(actor, 'report-queue')
          ? denyQueue(actor, 'evidence-queue')
          : null;
        if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
        const { url } = c.req.valid('json');
        const mod = getModerationServices();
        const verdict = mod.urlVerdict ? await mod.urlVerdict(url) : 'unavailable';
        mod.metrics.increment(`moderation.url_verdict.${verdict}`);
        return c.json(urlVerdictResponseSchema.parse({ verdict }));
      })

      // --- Case assignment (WS-J.2.1d) ------------------------------------
      .post(
        '/cases/:caseId/assign',
        zValidator('param', uuidParam('caseId')),
        zValidator('json', assignCaseRequestSchema),
        async (c) => {
          const actor = mustActor(c);
          const queueDenial = denyQueue(actor, 'report-queue');
          if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
          const { caseId } = c.req.valid('param');
          const { reviewer_id, reason } = c.req.valid('json');
          const mod = getModerationServices();
          const theCase = await mod.cases.getById(caseId);
          if (!theCase) return c.json(deny('not_found', 'Case not found'), 404);
          // The assignee must be able to access the report queue (least privilege).
          const assignee = await getIdentityServices().store.getUser(reviewer_id);
          if (!assignee) return c.json(deny('reviewer_not_found', 'Reviewer not found'), 404);
          const assigneeRoles = effectiveStewardRoles(assignee.roles, assignee.stewardRoles);
          if (!stewardRolesCanAccessQueue(assigneeRoles, 'report-queue')) {
            return c.json(
              deny('reviewer_ineligible', 'Reviewer cannot access the report queue'),
              400,
            );
          }
          // THE ASSIGNMENT IS NOW LIMITED, not just the button that offers it.
          //
          // This wrote `assignedTo` unconditionally: `theCase.assignedTo` was
          // fetched above and never read, there is no `If-Match` and no version on
          // the wire to echo, so two reviewers could both claim one case and both
          // be told 200 — last writer wins.  Hiding the client's claim button when
          // the case looks assigned narrowed the UI and left the route open, and
          // that button reads a 30-second-stale snapshot anyway, so a colleague
          // claiming mid-review still produced a silent takeover with ONE POST.
          //
          // Placed AFTER the assignee lookups on purpose: a precondition ahead of
          // them would answer 409 where the honest answer is 404
          // `reviewer_not_found` or 400 `reviewer_ineligible`.
          if (theCase.assignedTo === reviewer_id) {
            // Idempotent re-claim: the holder asking for what they already have is
            // not a conflict, and a retried request must not become one.
            return c.json(okResponseSchema.parse({ ok: true }));
          }
          // Held by someone else.  Taking a case off a colleague is a REASONED
          // reassignment — the flow the console's own comment describes — so it requires
          // the `reason` the schema already carries.  Without one the answer is a
          // refusal, not a silent handover.  Checked BEFORE the unit: it is a validation
          // of the request, not a write to roll back.
          if (theCase.assignedTo !== null && reason === undefined) {
            return c.json(
              deny('already_assigned', 'This case is assigned to another reviewer'),
              409,
            );
          }
          // THE OBSERVED PRIOR HOLDER, from whichever CAS actually ran — not
          // `theCase.assignedTo`, which is the read from before any of this and is
          // what made the audit describe an edge that never existed.
          // ONE UNIT (`moderation/transactor.ts`): the CAS and its audit row commit
          // together, so a reviewer taking this case off the next one cannot observe the
          // handover until the row recording it has landed too.  Appended after the
          // commit instead, a delayed request could put its row behind a later
          // reviewer's and the trail's most recent entry would name the wrong holder.
          const outcome = await mod.transactor.run(async (tx: ModerationTx) => {
            let priorHolder: string | null;
            if (theCase.assignedTo === null) {
              // THE CAS decides, not the read above — that read is already stale by
              // the time this line runs, which is the whole defect.
              const claimed = await tx.cases.claimIfUnassigned(caseId, reviewer_id);
              // A refusal RETURNS rather than throws: nothing has been written, so the
              // empty transaction commits and the caller answers 409.  What must never
              // happen is falling through to the audit — a row for an act that did not
              // occur, committed beside nothing.
              if (!claimed) return 'already_assigned' as const;
              priorHolder = null;
            } else {
              // A CAS HERE TOO.  This was an unconditional `update`, so two reviewers
              // taking the case off the same colleague both succeeded and
              // last-writer-won — the race `claimIfUnassigned` closed for an unassigned
              // case, left open one branch along.
              const reassigned = await tx.cases.reassignIfHeldBy(
                caseId,
                theCase.assignedTo,
                reviewer_id,
              );
              if (!reassigned) return 'already_moved' as const;
              priorHolder = theCase.assignedTo;
            }
            await tx.audit({
              actorUserId: actor.userId,
              actorRole: actor.stewardRoles[0] ?? null,
              action: 'assign',
              caseId: theCase.caseId,
              targetType: theCase.targetType,
              targetId: theCase.targetId,
              // NAMES BOTH HOLDERS.  The row recorded an `assign` on the target with
              // `subjectUserId: null` and no prior/next state, so the trail could not
              // say who took the case or from whom — the takeover was unattributable,
              // not merely unexplained.
              subjectUserId: reviewer_id,
              // The holder the CAS actually moved FROM, so this row is a true edge.
              priorState: priorHolder ?? 'unassigned',
              nextState: reviewer_id,
              notes: reason ?? null,
            });
            return 'assigned' as const;
          });
          if (outcome === 'already_assigned') {
            return c.json(
              deny('already_assigned', 'Another reviewer claimed this case first'),
              409,
            );
          }
          if (outcome === 'already_moved') {
            return c.json(deny('already_assigned', 'Another reviewer moved this case first'), 409);
          }
          mod.metrics.increment('moderation.assign');
          return c.json(okResponseSchema.parse({ ok: true }));
        },
      )

      // --- Action palette (WS-J.2.3a) -------------------------------------
      .post('/actions', zValidator('json', moderationActionRequestSchema), async (c) => {
        const actor = mustActor(c);
        const outcome = await applyAction(getModerationServices(), actor, c.req.valid('json'));
        if (!outcome.ok) {
          if (outcome.code === 'target_not_found') {
            return c.json(deny('target_not_found', outcome.message), 404);
          }
          if (outcome.code === 'enforcement_delayed') {
            return c.json(deny('enforcement_delayed', outcome.message), 409);
          }
          if (outcome.code === 'mfa_required') {
            return c.json(deny('mfa_required', outcome.message), 403);
          }
          if (outcome.code === 'invalid_action_for_target') {
            return c.json(deny('invalid_action_for_target', outcome.message), 400);
          }
          if (outcome.code === 'invalid_account_state') {
            return c.json(deny('invalid_account_state', outcome.message), 409);
          }
          return c.json(
            {
              error: {
                code: 'insufficient_capability',
                message: outcome.message,
                required_role: outcome.requiredRole,
              },
            },
            403,
          );
        }
        return c.json(moderationActionResponseSchema.parse(outcome.response), 201);
      })

      // --- Action revert (WS-J.2.3b) --------------------------------------
      .post(
        '/actions/:actionId/revert',
        zValidator('param', uuidParam('actionId')),
        zValidator('json', revertActionRequestSchema),
        async (c) => {
          const actor = mustActor(c);
          const { actionId } = c.req.valid('param');
          // Carry the steward's revert reason/note (validated above) into the
          // revert action + audit — the trail must record WHY this was reverted,
          // not inherit the original violation's reason.
          const { reason_code, reviewer_note } = c.req.valid('json');
          const outcome = await revertAction(getModerationServices(), actor, actionId, {
            reasonCode: reason_code,
            reviewerNote: reviewer_note ?? null,
          });
          if (!outcome.ok) {
            const status =
              outcome.code === 'not_found' ? 404 : outcome.code === 'not_reversible' ? 409 : 403;
            return c.json(deny(outcome.code, outcome.message), status);
          }
          return c.json(revertActionResponseSchema.parse(outcome.response));
        },
      )

      // --- Bulk actions (WS-J.2.1c) — per-item, reversible ----------------
      .post('/bulk', zValidator('json', bulkActionRequestSchema), async (c) => {
        const actor = mustActor(c);
        // Bulk operates on the report queue — gate it like the single-case routes
        // (a steward outside the report queue cannot bulk-assign/dismiss/remove).
        const queueDenial = denyQueue(actor, 'report-queue');
        if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), DENIAL_STATUS);
        const { case_ids, action, reason_code, reviewer_id } = c.req.valid('json');
        const mod = getModerationServices();
        const max = mod.config().bulkActionMax;
        if (case_ids.length > max) {
          return c.json(deny('bulk_too_large', `Maximum ${max} items per bulk action`), 400);
        }
        // For an assignment, validate the assignee ONCE (least privilege, like the
        // single-case route) before touching any case.
        if (action === 'assign' && reviewer_id) {
          const assignee = await getIdentityServices().store.getUser(reviewer_id);
          const assigneeRoles = assignee
            ? effectiveStewardRoles(assignee.roles, assignee.stewardRoles)
            : [];
          if (!assignee || !stewardRolesCanAccessQueue(assigneeRoles, 'report-queue')) {
            return c.json(
              deny('reviewer_ineligible', 'Reviewer cannot access the report queue'),
              400,
            );
          }
        }
        const results = [];
        for (const caseId of case_ids) {
          const theCase = await mod.cases.getById(caseId);
          if (!theCase) {
            results.push({ case_id: caseId, ok: false, error: 'not_found' });
            continue;
          }
          if (action === 'assign') {
            if (!reviewer_id) {
              results.push({ case_id: caseId, ok: false, error: 'reviewer_required' });
              continue;
            }
            // THE SAME GUARD AS THE SINGLE ASSIGN, or this is a complete bypass
            // of it — bulk assign overwrote ANY case's assignee and did not even
            // forward the request's `reason_code`, so it could still silently steal
            // a colleague's in-progress case one page at a time.
            if (theCase.assignedTo === reviewer_id) {
              // ALREADY HELD BY THIS REVIEWER: short-circuit exactly as the single
              // route does, writing NO audit row.  My first version let this fall
              // through to the write below, which recorded another assignment whose
              // prior state was falsely `unassigned` — so an ordinary idempotent
              // retry corrupted an append-only history.  A no-op is not an event.
              results.push({ case_id: caseId, ok: true, error: null });
              continue;
            }
            if (theCase.assignedTo !== null) {
              results.push({ case_id: caseId, ok: false, error: 'already_assigned' });
              continue;
            }
            // ONE UNIT per case, as the single assign is — and per CASE rather than
            // around the loop: locking many case rows in request order would let two
            // bulk operations over overlapping sets deadlock on each other.
            const assigned = await mod.transactor.run(async (tx: ModerationTx) => {
              const claimed = await tx.cases.claimIfUnassigned(caseId, reviewer_id);
              if (!claimed) return false;
              await tx.audit({
                actorUserId: actor.userId,
                actorRole: actor.stewardRoles[0] ?? null,
                action: 'assign',
                caseId: theCase.caseId,
                targetType: theCase.targetType,
                targetId: theCase.targetId,
                // Named here too — the bulk path wrote the row with no identities and
                // no notes at all.
                subjectUserId: reviewer_id,
                // Reached only via the CAS above, so the case WAS unassigned — but
                // stated from the row rather than as a literal, because a literal is
                // what made the retry path lie.
                priorState: theCase.assignedTo ?? 'unassigned',
                nextState: reviewer_id,
                notes: reason_code ?? null,
              });
              return true;
            });
            if (!assigned) {
              results.push({ case_id: caseId, ok: false, error: 'already_assigned' });
              continue;
            }
            results.push({ case_id: caseId, ok: true, error: null });
            continue;
          }
          // An `account`-target case whose user was erased (right-to-erasure
          // NULLed the id) has no live target to act on — skip it.
          if (theCase.targetId === null) {
            results.push({ case_id: caseId, ok: false, error: 'target_erased' });
            continue;
          }
          // dismiss → clear; remove → remove (each individually authorized + audited).
          const verb: ConsoleAction = action === 'dismiss' ? 'clear' : 'remove';
          const outcome = await applyAction(mod, actor, {
            // Pass the case's real target type (content/account/room) — a room
            // case bulk-dismisses via `clear`; an enforcement verb on it is
            // rejected by applyAction (reported as that item's error).
            target_type: theCase.targetType,
            target_id: theCase.targetId,
            action: verb,
            reason_code,
            case_id: caseId,
          });
          results.push({
            case_id: caseId,
            ok: outcome.ok,
            error: outcome.ok ? null : outcome.code,
          });
        }
        return c.json(bulkActionResponseSchema.parse({ results }));
      })

      // --- Reviewer availability (WS-J.2.1d) ------------------------------
      // The caller's own availability.  The console needs this to INITIALISE its
      // control: a fixed local default told a reviewer they were `available`
      // while `availableIds()` still excluded them, and merely opening the
      // console did not correct it.  Same authorization bar as the write.
      .get('/reviewer-status', async (c) => {
        const actor = mustActor(c);
        if (denyQueue(actor, 'report-queue') && denyQueue(actor, 'appeal-queue')) {
          return c.json(
            deny('forbidden', 'Only report or appeal reviewers can read availability'),
            DENIAL_STATUS,
          );
        }
        const mod = getModerationServices();
        const record = await mod.reviewerStatus.get(actor.userId);
        // Never stored ⇒ `offline`: a reviewer who has not opted in is not in
        // the pool, and reporting `available` would be the same lie in reverse.
        return c.json(reviewerStatusResponseSchema.parse({ status: record?.status ?? 'offline' }));
      })
      .post('/reviewer-status', zValidator('json', reviewerStatusRequestSchema), async (c) => {
        const actor = mustActor(c);
        // Only an actual report/appeal reviewer may enter the auto-assignment
        // pool — an evidence-only (or other non-reviewer) steward marking
        // `available` must not receive auto-assigned reports/appeals (#18).
        if (denyQueue(actor, 'report-queue') && denyQueue(actor, 'appeal-queue')) {
          return c.json(
            deny('forbidden', 'Only report or appeal reviewers can set availability'),
            DENIAL_STATUS,
          );
        }
        const { status } = c.req.valid('json');
        const mod = getModerationServices();
        await mod.reviewerStatus.set(actor.userId, status, new Date(mod.now()).toISOString());
        return c.json(okResponseSchema.parse({ ok: true }));
      })

      // --- Coordinated-report incidents (WS-J.2.6e / MFCI-2) --------------
      // The integrity queue: ONLY ROLE_INTEGRITY (integrity-queue access) may
      // list or resolve incidents.  Resolving an incident reconciles the linked
      // case's enforcement delay (clear ⇒ lift; confirm ⇒ dismiss the case).
      .get(
        '/incidents',
        zValidator('query', z.object({ cursor: z.string().min(1).max(512).optional() })),
        async (c) => {
          const actor = mustActor(c);
          const queueDenial = denyQueue(actor, 'integrity-queue');
          if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
          const result = await buildIncidentQueue(
            getModerationServices(),
            100,
            c.req.valid('query').cursor,
          );
          return c.json(incidentQueueResponseSchema.parse(result));
        },
      )
      .post(
        '/incidents/:incidentId/resolve',
        zValidator('param', uuidParam('incidentId')),
        zValidator('json', incidentResolveRequestSchema),
        async (c) => {
          const actor = mustActor(c);
          const queueDenial = denyQueue(actor, 'integrity-queue');
          if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
          const { incidentId } = c.req.valid('param');
          const { resolution, note } = c.req.valid('json');
          const outcome = await resolveIncident(
            getModerationServices(),
            actor,
            incidentId,
            resolution,
            note,
          );
          if (!outcome.ok) {
            return c.json(
              deny(outcome.code, outcome.message),
              outcome.code === 'not_found' ? 404 : 409,
            );
          }
          return c.json(
            incidentResolveResponseSchema.parse({
              incident: outcome.incident,
              case_status: outcome.caseStatus,
            }),
          );
        },
      )

      // --- Evidence queue + decisions (STEWARD_ROLES.md ROLE_EVIDENCE) ----
      // The queue is DERIVED: citation-bearing published contributions with no
      // decision row yet, oldest first.  Decisions are evidence METADATA (no
      // content-removal power) — `mark-primary-source`/`flag-citation` require
      // the exact doctrine capability; `clear` is queue workflow (access-gated).
      .get(
        '/evidence-queue',
        zValidator(
          'query',
          z.object({
            cursor: z.string().min(1).max(512).optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
          }),
        ),
        async (c) => {
          const actor = mustActor(c);
          const queueDenial = denyQueue(actor, 'evidence-queue');
          if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
          const q = c.req.valid('query');
          const result = await buildEvidenceQueue(getModerationServices(), {
            cursor: q.cursor,
            limit: q.limit ?? 25,
          });
          return c.json(evidenceQueueResponseSchema.parse(result));
        },
      )
      .get(
        '/evidence-decisions',
        zValidator(
          'query',
          z.object({
            contribution_id: uuidSchema.optional(),
            cursor: z.string().min(1).max(512).optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
          }),
        ),
        async (c) => {
          const actor = mustActor(c);
          const queueDenial = denyQueue(actor, 'evidence-queue');
          if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
          const q = c.req.valid('query');
          const mod = getModerationServices();
          const limit = q.limit ?? 50;
          let nextCursor: string | null = null;
          const [curTime, curId] = decodeKeysetTuple(q.cursor);
          let records = await mod.evidenceDecisions.listRecent({
            ...(curTime && curId ? { after: { createdAt: curTime, decisionId: curId } } : {}),
            limit: limit + 1,
          });
          const last = records[limit - 1];
          if (records.length > limit && last) {
            nextCursor = Buffer.from(`${last.createdAt}|${last.decisionId}`, 'utf-8').toString(
              'base64url',
            );
          }
          records = records.slice(0, limit);
          const deciderIds = [
            ...new Set(records.map((r) => r.decidedBy).filter((id): id is string => id !== null)),
          ];
          const resolved = await mod.users.resolveMany(deciderIds);
          const handles = new Map<string, string | null>();
          for (const id of deciderIds) handles.set(id, resolved.get(id)?.handle ?? null);
          return c.json(
            evidenceDecisionsResponseSchema.parse({
              items: records.map((r) => decisionToView(r, handles)),
              next_cursor: nextCursor,
            }),
          );
        },
      )
      .post('/evidence-decisions', zValidator('json', evidenceDecisionRequestSchema), async (c) => {
        const actor = mustActor(c);
        const mod = getModerationServices();
        const outcome = await applyEvidenceDecision(mod, actor, c.req.valid('json'));
        if (!outcome.ok) {
          const status =
            outcome.code === 'target_not_found'
              ? 404
              : outcome.code === 'citation_not_found'
                ? 400
                : outcome.code === 'citation_malicious'
                  ? 422
                  : outcome.code === 'duplicate_decision'
                    ? 409
                    : 403;
          return c.json(deny(outcome.code, outcome.message), status);
        }
        const decider = outcome.record.decidedBy;
        const resolved = decider === null ? new Map() : await mod.users.resolveMany([decider]);
        const handles = new Map<string, string | null>(
          decider === null ? [] : [[decider, resolved.get(decider)?.handle ?? null]],
        );
        return c.json(
          evidenceDecisionViewSchema.parse(decisionToView(outcome.record, handles)),
          201,
        );
      })

      // --- Appeal queue + review + decision (WS-J.1.3c, WS-J.2.4a) --------
      .get(
        '/appeals',
        zValidator(
          'query',
          z.object({
            status: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
            cursor: z.string().min(1).max(512).optional(),
          }),
        ),
        async (c) => {
          const actor = mustActor(c);
          const queueDenial = denyQueue(actor, 'appeal-queue');
          if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
          const q = c.req.valid('query');
          const status = q.status === 'pending' ? (['pending'] as const) : undefined;
          const result = await buildAppealQueue(
            getModerationServices(),
            status,
            q.limit ?? 50,
            q.cursor,
          );
          return c.json(appealQueueResponseSchema.parse(result));
        },
      )
      .get('/appeals/:appealId', zValidator('param', uuidParam('appealId')), async (c) => {
        const actor = mustActor(c);
        const queueDenial = denyQueue(actor, 'appeal-queue');
        if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
        const { appealId } = c.req.valid('param');
        const review = await buildAppealReview(getModerationServices(), appealId);
        if (!review) return c.json(deny('not_found', 'Appeal not found'), 404);
        return c.json(appealReviewResponseSchema.parse(review));
      })
      .post(
        '/appeals/:appealId/decision',
        zValidator('param', uuidParam('appealId')),
        zValidator('json', appealDecisionRequestSchema),
        async (c) => {
          const actor = mustActor(c);
          const queueDenial = denyQueue(actor, 'appeal-queue');
          if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
          const { appealId } = c.req.valid('param');
          const body = c.req.valid('json');
          const outcome = await decideAppeal(
            getModerationServices(),
            actor,
            appealId,
            body.decision,
            body.reason_code as ModerationReasonCode,
            body.explanation,
            body.modified_action,
          );
          if (!outcome.ok) {
            const status =
              outcome.code === 'not_found'
                ? 404
                : outcome.code === 'already_decided'
                  ? 409
                  : outcome.code === 'invalid_modification'
                    ? 400
                    : 403;
            return c.json(deny(outcome.code, outcome.message), status);
          }
          return c.json(
            appealDecisionResponseSchema.parse({
              appeal_id: appealId,
              status: outcome.status,
              notice_sent: outcome.noticeSent,
              created_at: new Date(getModerationServices().now()).toISOString(),
            }),
          );
        },
      )

      // --- Audit viewer + transparency export (WS-J.2.5b) -----------------
      .get('/audit', zValidator('query', auditQuerySchema), async (c) => {
        const actor = mustActor(c);
        // The audit log is the accountability surface — gated to moderation /
        // integrity / appeals roles (an evidence-only steward cannot read it).
        if (!auditReadAllowed(actor)) {
          return c.json(deny('forbidden', 'Audit access requires a moderation role'), 403);
        }
        const q = c.req.valid('query');
        const mod = getModerationServices();
        // Keyset cursor on the append ORDINAL — stable when the `audit_view`
        // meta-record below is inserted between page reads (an offset cursor would
        // shift, duplicating/skipping rows), and EXACT across the wire round trip,
        // which the previous `(eventTime, auditId)` pair was not: the timestamp came
        // back from the driver already truncated to the millisecond, so each page
        // silently dropped the rest of the cursor row's millisecond (migration 0115).
        const cursor = decodeAuditCursor(q.cursor);
        const limit = q.limit ?? 50;
        const records = await mod.audit.list({
          ...(q.actor_id ? { actorUserId: q.actor_id } : {}),
          ...(q.target_user ? { subjectUserId: q.target_user } : {}),
          ...(q.action ? { action: q.action } : {}),
          ...(q.reason_code ? { reasonCode: q.reason_code } : {}),
          ...(q.created_after ? { createdAfter: q.created_after } : {}),
          ...(q.created_before ? { createdBefore: q.created_before } : {}),
          ...cursor,
          limit: limit + 1,
        });
        const page = records.slice(0, limit);
        const actorIds = [
          ...new Set(
            page.flatMap((r) =>
              [r.actorUserId, r.coApproverUserId].filter((x): x is string => x !== null),
            ),
          ),
        ];
        const resolved = await mod.users.resolveMany(actorIds);
        const handles = new Map<string, string | null>();
        for (const id of actorIds) handles.set(id, resolved.get(id)?.handle ?? null);
        const items = page.map((r) => auditToView(r, handles, true));
        const last = page[page.length - 1];
        const nextCursor = records.length > limit && last ? encodeAuditCursor(last.ordinal) : null;
        // The audit log is itself an accountability surface — every successful
        // read is meta-audited with its query scope (parity with /audit/export
        // below), so steward inspection of the trail is never invisible.
        await writeAudit(mod, {
          actorUserId: actor.userId,
          actorRole: actor.stewardRoles[0] ?? null,
          action: 'audit_view',
          targetType: 'audit',
          notes: auditQueryScope(q),
        });
        return c.json(auditListResponseSchema.parse({ items, next_cursor: nextCursor }));
      })
      .get(
        '/audit/export',
        zValidator(
          'query',
          z.object({
            created_after: z.string().datetime().optional(),
            created_before: z.string().datetime().optional(),
          }),
        ),
        async (c) => {
          const actor = mustActor(c);
          if (!auditReadAllowed(actor)) {
            return c.json(deny('forbidden', 'Audit access requires a moderation role'), 403);
          }
          const mod = getModerationServices();
          const nowMs = mod.now();
          const start =
            c.req.valid('query').created_after ?? new Date(nowMs - 30 * 86_400_000).toISOString();
          const end = c.req.valid('query').created_before ?? new Date(nowMs).toISOString();
          const records = await mod.audit.listInPeriod(start, end);
          const report = buildTransparencyExport(
            records,
            mod.config().transparencySuppressionThreshold,
            start,
            end,
            new Date(nowMs).toISOString(),
          );
          // Every export is itself audited (WS-J.2.5b).
          await writeAudit(mod, {
            actorUserId: actor.userId,
            actorRole: actor.stewardRoles[0] ?? null,
            action: 'audit_export',
            targetType: 'audit',
            notes: `period ${start}..${end}`,
          });
          return c.json(auditExportResponseSchema.parse(report));
        },
      )

      // --- Runtime config (steward; WS-J.1.1d/2.6 "configurable without deploy") ---
      // Reads + writes are restricted to the abuse-enforcement roles: the
      // rate limits, spam thresholds, and malware-domain denylist govern
      // enforcement, so an evidence-only or appeals-only steward must not see or
      // change them.  Every write is audited with the keys it touched.
      .get('/config', async (c) => {
        const actor = mustActor(c);
        if (!configAccessAllowed(actor)) {
          return c.json(deny('forbidden', 'Config access requires a moderation role'), 403);
        }
        const mod = getModerationServices();
        await mod.reloadConfig();
        return c.json(mod.config() as unknown as Record<string, unknown>);
      })
      .patch('/config', zValidator('json', z.record(z.string(), z.unknown())), async (c) => {
        const actor = mustActor(c);
        if (!configAccessAllowed(actor)) {
          return c.json(deny('forbidden', 'Config changes require a moderation role'), 403);
        }
        const mod = getModerationServices();
        const patch = c.req.valid('json');
        // Per-key problems go in `apiErrorSchema`'s own `details` map — the
        // field documented as "field-level details for form validation
        // surfaces" — rather than in a `fields: [{key, message}]` array of this
        // route's own invention.  The client validates every error body against
        // that schema and keeps only what it declares, so the invented array
        // was dropped on arrival: the console showed "Invalid config" and never
        // which key was wrong, which is the entire content of the answer.
        const details: Record<string, string> = {};
        for (const [key, value] of Object.entries(patch)) {
          if (!(MODERATION_CONFIG_KEYS as string[]).includes(key)) {
            details[key] = 'unknown key';
            continue;
          }
          const problem = validateModerationConfigValue(key, value);
          if (problem) details[key] = problem;
        }
        if (Object.keys(details).length > 0) {
          return c.json(
            { error: { code: 'validation_error', message: 'Invalid config', details } },
            422,
          );
        }
        const changedKeys = Object.keys(patch);
        for (const [key, value] of Object.entries(patch)) {
          await storeModerationConfigValue(mod.configStore, key, value);
        }
        await mod.reloadConfig();
        // Audit the change (keys only — values may include the malware-domain
        // denylist; the keys touched are the accountability record).
        await writeAudit(mod, {
          actorUserId: actor.userId,
          actorRole: actor.stewardRoles[0] ?? null,
          action: 'config_update',
          targetType: 'config',
          notes: `keys: ${changedKeys.join(', ')}`,
        });
        return c.json(mod.config() as unknown as Record<string, unknown>);
      })
  );
}

export type ModerationConsoleRoutes = ReturnType<typeof createModerationConsoleRoutes>;
