// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2 moderation console routes (SPEC §18.2/§18.3, §16.4, §25.4): the report
// queue + filters + bulk + assignment (WS-J.2.1), the full-context review panel
// (WS-J.2.2), the action palette + revert (WS-J.2.3), the appeal review
// interface (WS-J.2.4), and the audit viewer + transparency export (WS-J.2.5).
// Every view/action is authorized by doctrine steward role + verified MFA, and
// the reads/exports are themselves audited.  Financial data never appears.
import { zValidator } from '@hono/zod-validator';
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
  stewardRolesCanAccessQueue,
  urlVerdictRequestSchema,
  urlVerdictResponseSchema,
  uuidSchema,
} from '@licio/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { getIdentityServices } from '../identity/services.js';
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
import { buildIncidentQueue, resolveIncident } from '../moderation/incidents.js';
import {
  buildAppealQueue,
  buildAppealReview,
  buildCaseReview,
  buildReportQueue,
} from '../moderation/review.js';
import { getModerationServices } from '../moderation/services.js';

const deny = (code: string, message: string) => ({ error: { code, message } });
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
    if (!auth.mfaActive || !auth.mfaVerified) {
      return c.json(deny('mfa_required', 'Verify MFA to use the moderation console'), 403);
    }
    if (!isStewardActor(actorOf(auth))) {
      return c.json(deny('forbidden', 'Steward role required'), 403);
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
      // navigating.  Same access gate as the review panel the links render in.
      // An unwired verdict seam reports `unavailable` — fail toward flagging,
      // never trusting.
      .post('/url-verdict', zValidator('json', urlVerdictRequestSchema), async (c) => {
        const actor = mustActor(c);
        const queueDenial = denyQueue(actor, 'report-queue');
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
          await mod.cases.update(caseId, { assignedTo: reviewer_id, status: 'in_progress' });
          await writeAudit(mod, {
            actorUserId: actor.userId,
            actorRole: actor.stewardRoles[0] ?? null,
            action: 'assign',
            targetType: theCase.targetType,
            targetId: theCase.targetId,
            subjectUserId: null,
            notes: reason ?? null,
          });
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
            await mod.cases.update(caseId, { assignedTo: reviewer_id, status: 'in_progress' });
            await writeAudit(mod, {
              actorUserId: actor.userId,
              actorRole: actor.stewardRoles[0] ?? null,
              action: 'assign',
              targetType: theCase.targetType,
              targetId: theCase.targetId,
            });
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
        // Keyset cursor on (eventTime, auditId) DESC — stable when the
        // `audit_view` meta-record below is inserted between page reads (an
        // offset cursor would shift, duplicating/skipping rows).
        const [curTime, curId] = q.cursor
          ? Buffer.from(q.cursor, 'base64url').toString('utf-8').split('|')
          : [undefined, undefined];
        const limit = q.limit ?? 50;
        const records = await mod.audit.list({
          ...(q.actor_id ? { actorUserId: q.actor_id } : {}),
          ...(q.target_user ? { subjectUserId: q.target_user } : {}),
          ...(q.action ? { action: q.action } : {}),
          ...(q.reason_code ? { reasonCode: q.reason_code } : {}),
          ...(q.created_after ? { createdAfter: q.created_after } : {}),
          ...(q.created_before ? { createdBefore: q.created_before } : {}),
          ...(curTime && curId ? { afterEventTime: curTime, afterAuditId: curId } : {}),
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
        const nextCursor =
          records.length > limit && last
            ? Buffer.from(`${last.eventTime}|${last.auditId}`, 'utf-8').toString('base64url')
            : null;
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
        const fields: Array<{ key: string; message: string }> = [];
        for (const [key, value] of Object.entries(patch)) {
          if (!(MODERATION_CONFIG_KEYS as string[]).includes(key)) {
            fields.push({ key, message: 'unknown key' });
            continue;
          }
          const problem = validateModerationConfigValue(key, value);
          if (problem) fields.push({ key, message: problem });
        }
        if (fields.length > 0) {
          return c.json(
            { error: { code: 'validation_error', message: 'Invalid config', fields } },
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
