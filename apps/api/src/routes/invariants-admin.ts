// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Steward/analyst-gated WS-H operational surface (requireSteward — the same
// per-session-MFA bar as every steward action; SPEC §21.4 access controls):
//
//   GET  /v1/invariants/admin/health            — uniform per-invariant health
//     (WS-H.1.2g) + card + live shadow status (WS-H.1.2c-2 dashboard feed).
//   GET  /v1/invariants/admin/outputs           — recent outputs for a target
//     (analyst dashboards; reason-code filterable, WS-H.1.1c).
//   GET  /v1/invariants/admin/compare           — paired two-version outputs
//     (WS-H.1.1b A/B comparison; optional time-window filter).
//   GET  /v1/invariants/admin/mfci/dashboard    — shadow anomaly reports +
//     open cases + the calibration in force (WS-H.3.1c/WS-H.3.2c; strictly
//     observational — there is deliberately NO enforcement action here).
//   POST /v1/invariants/admin/mfci/cases/:id/resolve — confirm/clear/escalate
//     (WS-H.3.4b); clearing lifts any safety freeze (WS-H.3.3d); audited.
//   GET  /v1/invariants/admin/gwei/dashboard    — cohort comparisons
//     (k-anonymity enforced at computation; suppressed cells stay withheld).
//   GET  /v1/invariants/admin/gwei/transparency — the public-safe aggregate
//     parity export (WS-H.5.2d): parity statements only, never cohort detail.
//   GET  /v1/invariants/admin/promotions/:type  — status + history.
//   POST /v1/invariants/admin/promotions        — promotion/demotion through
//     the WS-H.1.2e checklist (422 on rejection); audited.
//   PUT  /v1/invariants/admin/config            — validated runtime-config
//     writes (422 at configuration time); audited.
//   GET  /v1/invariants/admin/regression        — on-demand drift report
//     (WS-H.1.2d-2).

import { zValidator } from '@hono/zod-validator';
import { INVARIANT_TYPE_NAMES, nextRiskState, runRegressionSuite } from '@licio/invariants';
import { MODERATION_REASON_CODES } from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { type EventPipelineServices, getEventPipelineServices } from '../events/services.js';
import { type ForumServices, getForumServices } from '../forum/services.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { getIngestionServices, type IngestionServices } from '../ingestion/services.js';
import {
  INVARIANTS_CONFIG_KEYS,
  storeInvariantsConfigValue,
  validateInvariantsConfigValue,
} from '../invariants/config.js';
import {
  annotateThreadLenses,
  bridgeCandidatesFor,
  latestScoiFor,
  recomputeScoiFor,
} from '../invariants/scoi-actions.js';
import { getInvariantServices, type InvariantPlatformServices } from '../invariants/services.js';
import { type AuthEnv, authMiddleware, getAuth, requireSteward } from '../middleware/auth.js';
import { resolveItemSafetyState } from '../pwatt/scoring.js';

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

const invariantTypeSchema = z.enum(INVARIANT_TYPE_NAMES);

const promotionBodySchema = z
  .object({
    invariant_type: invariantTypeSchema,
    from_status: z.enum(['shadow', 'soft_constraint', 'hard_constraint']),
    to_status: z.enum(['shadow', 'soft_constraint', 'hard_constraint']),
    evidence: z
      .object({
        shadow_duration_days: z.number().nonnegative(),
        drift_report_ref: z.string().max(512),
        observed_coverage: z.number().min(0).max(1),
        observed_confidence: z.number().min(0).max(1),
      })
      .strict(),
    owner: z.string().min(1).max(256),
  })
  .strict();

const configBodySchema = z.object({ key: z.string().min(1).max(128), value: z.unknown() }).strict();

const resolveBodySchema = z
  .object({ action: z.enum(['confirmed', 'cleared', 'escalated']) })
  .strict();

const REASON_CODE_SET: ReadonlySet<string> = new Set(MODERATION_REASON_CODES);

const contextActionBodySchema = z
  .object({
    action: z.enum(['merge', 'annotate', 'separate']),
    reason_code: z.string().min(1).max(64),
    annotation: z.string().min(1).max(4_000).optional(),
    related_thread_id: z.string().uuid().optional(),
  })
  .strict();

export function createInvariantsAdminRoutes(
  resolveIdentity: () => IdentityServices = getIdentityServices,
  resolveEvents: () => EventPipelineServices = getEventPipelineServices,
  resolveInvariants: () => InvariantPlatformServices = getInvariantServices,
  resolveForum: () => ForumServices = getForumServices,
  resolveIngestion: () => IngestionServices = getIngestionServices,
) {
  return new Hono<AuthEnv>()
    .use('*', authMiddleware(resolveIdentity))
    .use('*', requireSteward())

    .get('/health', async (c) => {
      const invariants = resolveInvariants();
      const entries = await Promise.all(
        invariants.all().map(async (service) => ({
          invariant_type: service.invariantType,
          shadow_status: await invariants.promotionService.statusOf(service.invariantType),
          tiers: service.tiers,
          health: service.getHealthMetrics(),
          recent_runs: await invariants.runMetadata.listRecent(service.invariantType, 5),
          card: service.getCard(),
        })),
      );
      return c.json({ invariants: entries });
    })

    .get('/outputs', async (c) => {
      const targetId = c.req.query('target_id');
      if (!targetId || !z.string().uuid().safeParse(targetId).success) {
        return c.json(deny('invalid_target', 'target_id must be a UUID'), 422);
      }
      const reasonCode = c.req.query('reason_code');
      const rows = (await resolveEvents().invariantStore.listForTarget(targetId)).filter(
        (row) => !reasonCode || row.reasonCodes.includes(reasonCode),
      );
      return c.json({ outputs: rows });
    })

    .get('/compare', async (c) => {
      const parsed = z
        .object({
          invariant_type: invariantTypeSchema,
          version_a: z.string().min(1).max(32),
          version_b: z.string().min(1).max(32),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        })
        .safeParse({
          invariant_type: c.req.query('invariant_type'),
          version_a: c.req.query('version_a'),
          version_b: c.req.query('version_b'),
          from: c.req.query('from'),
          to: c.req.query('to'),
        });
      if (!parsed.success) {
        return c.json(deny('invalid_query', parsed.error.issues[0]?.message ?? 'invalid'), 422);
      }
      const { invariant_type, version_a, version_b, from, to } = parsed.data;
      const rows = await resolveEvents().invariantStore.listForVersionComparison(
        invariant_type,
        version_a,
        version_b,
        from && to ? { start: from, end: to } : undefined,
      );
      return c.json({ outputs: rows });
    })

    .get('/mfci/dashboard', async (c) => {
      const invariants = resolveInvariants();
      const events = resolveEvents();
      const cases = await invariants.mfciCases.listOpen(50);
      const calibration = await invariants.calibrations.get('mfci:target_concentration');
      const outputs = (await events.invariantStore.listAll())
        .filter((row) => row.invariantType === 'MFCI')
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 100);
      return c.json({ open_cases: cases, calibration, recent_outputs: outputs });
    })

    .post('/mfci/cases/:caseId/resolve', zValidator('json', resolveBodySchema), async (c) => {
      const auth = getAuth(c);
      if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
      const invariants = resolveInvariants();
      const identity = resolveIdentity();
      const { action } = c.req.valid('json');
      const caseId = c.req.param('caseId');
      if (!z.string().uuid().safeParse(caseId).success) {
        return c.json(deny('invalid_case', 'caseId must be a UUID'), 422);
      }
      const resolved = await invariants.mfciCases.resolve(
        caseId,
        action,
        `steward:${auth.userId}`,
        new Date(invariants.now()).toISOString(),
      );
      if (!resolved) return c.json(deny('not_found', 'No open case with that id'), 404);
      // Fiber-test/analyst clearing lifts the safety freeze (WS-H.3.3d)
      // AND releases the held risk state through the analyst-override
      // evidence path (WS-H.3.4a: downward needs clearing or an override).
      if (action === 'cleared') {
        await resolveItemSafetyState(
          resolveEvents(),
          identity,
          resolved.targetId,
          'clear',
          `steward:${auth.userId}`,
        );
        const current = (await invariants.mfciRiskStates.get(resolved.targetId))?.state ?? 'normal';
        const transition = nextRiskState(current, 0, invariants.config().mfciRiskThresholds, {
          analystOverride: true,
        });
        await invariants.mfciRiskStates.set({
          targetId: resolved.targetId,
          state: transition.to,
          score: 0,
          reason: transition.reason,
          updatedAt: new Date(invariants.now()).toISOString(),
        });
      }
      await identity.audit.append({
        actorUserId: auth.userId,
        eventType: 'mfci_case_action',
        targetRef: caseId,
        context: { action, target_id: resolved.targetId, risk_state: resolved.riskState },
      });
      return c.json({ case: resolved });
    })

    .get('/mfci/margins/:marginsRef', async (c) => {
      // MFCI-4: dereference a fixed_margins_ref to the persisted
      // conditioning record (axes, 1-way margins, table total).
      const record = await resolveInvariants().mfciMargins.get(c.req.param('marginsRef'));
      if (!record) return c.json(deny('not_found', 'No margins record with that ref'), 404);
      return c.json({ margins: record });
    })

    .get('/gwei/dashboard', async (c) => {
      const rows = (await resolveEvents().invariantStore.listAll())
        .filter((row) => row.invariantType === 'GWEI')
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 100);
      return c.json({ comparisons: rows });
    })

    .get('/gwei/transparency', async (c) => {
      // Public-safe aggregate parity statements (WS-H.5.2d): no cohort
      // metrics, no suppressed-cell detail — parity vs under-review only.
      const rows = (await resolveEvents().invariantStore.listAll()).filter(
        (row) => row.invariantType === 'GWEI',
      );
      const threshold = 0.5;
      const statements = rows.map((row) => {
        const suppressed = row.reasonCodes.includes('SUPPRESSED_K_ANONYMITY');
        const gw2 = typeof row.scoreVector['gw2'] === 'number' ? row.scoreVector['gw2'] : null;
        return {
          window: row.timeWindow,
          status: suppressed
            ? 'withheld_small_cohort'
            : gw2 !== null && gw2 <= threshold
              ? 'parity_within_threshold'
              : 'degradation_under_review',
        };
      });
      return c.json({ generated_at: new Date().toISOString(), statements });
    })

    .get('/scoi/reports/:roomId', async (c) => {
      // WS-H.4.1c steward reports — scoped to the room's OWN stewards
      // (404-over-403: an out-of-scope steward learns nothing).
      const auth = getAuth(c);
      if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
      const roomId = c.req.param('roomId');
      if (!z.string().uuid().safeParse(roomId).success) {
        return c.json(deny('invalid_room', 'roomId must be a UUID'), 422);
      }
      const forum = resolveForum();
      const roles = await forum.rooms.stewardRolesFor(roomId, auth.userId);
      if (roles.length === 0) return c.json(deny('not_found', 'No such report'), 404);
      const ingestion = resolveIngestion();
      const events = resolveEvents();
      const invariants = resolveInvariants();
      const lenses = await forum.lenses.listByRoom(roomId);
      const lensNames = new Map(lenses.map((lens) => [lens.lensId, lens.name]));
      const entries = [];
      for (const story of await ingestion.stories.listRecent(200)) {
        const thread = await ingestion.stories.getThreadByStoryId(story.storyId);
        if (!thread || thread.roomId !== roomId) continue;
        const scoi = await latestScoiFor(events, story.storyId);
        if (!scoi) continue;
        // Per-lens interpretation summaries: tagged contribution counts.
        const contributions = await forum.contributions.listByThread(thread.threadId, {
          limit: 500,
        });
        const perLens = new Map<string, number>();
        for (const contribution of contributions) {
          const lensId = contribution.metadata['lens_id'];
          if (typeof lensId !== 'string') continue;
          perLens.set(lensId, (perLens.get(lensId) ?? 0) + 1);
        }
        const recommended =
          scoi.contextState === 'split' || scoi.contextState === 'obstructed'
            ? ['invite_bridge', 'annotate_context']
            : scoi.contextState === 'weaponized'
              ? ['safety_review']
              : scoi.contextState === 'ambiguous'
                ? ['monitor']
                : [];
        entries.push({
          story_id: story.storyId,
          thread_id: thread.threadId,
          title: story.title,
          context_state: scoi.contextState,
          scoi: scoi.scoi,
          lenses: [...perLens.entries()].map(([lensId, count]) => ({
            lens_id: lensId,
            name: lensNames.get(lensId) ?? lensId,
            contribution_count: count,
          })),
          recommended_actions: recommended,
          // The §10.5 "Bridge attempts" branch + recent context actions.
          bridge_attempts: await invariants.bridgeAttempts.listForThread(thread.threadId, 10),
          context_actions: await invariants.scoiActions.listForThread(thread.threadId, 10),
        });
      }
      return c.json({ room_id: roomId, reports: entries });
    })

    .post(
      '/scoi/threads/:threadId/actions',
      zValidator('json', contextActionBodySchema),
      async (c) => {
        // WS-H.4.3d moderator context actions (SCOI-4): merge / annotate /
        // separate — ratified reason code, steward room scope, audited,
        // and (for annotate/merge) SCOI re-computation with the measured
        // before/after on the record.
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const threadId = c.req.param('threadId');
        if (!z.string().uuid().safeParse(threadId).success) {
          return c.json(deny('invalid_thread', 'threadId must be a UUID'), 422);
        }
        const body = c.req.valid('json');
        if (!REASON_CODE_SET.has(body.reason_code)) {
          return c.json(deny('invalid_reason', 'reason_code must be a ratified WS-A code'), 422);
        }
        if (body.action === 'annotate' && !body.annotation) {
          return c.json(deny('missing_annotation', 'annotate requires an annotation body'), 422);
        }
        if (body.action === 'merge' && !body.related_thread_id) {
          return c.json(deny('missing_related', 'merge requires related_thread_id'), 422);
        }
        const forum = resolveForum();
        const ingestion = resolveIngestion();
        const thread = await ingestion.stories.getThreadById(threadId);
        if (!thread) return c.json(deny('not_found', 'No such thread'), 404);
        const roles = thread.roomId
          ? await forum.rooms.stewardRolesFor(thread.roomId, auth.userId)
          : [];
        if (roles.length === 0) return c.json(deny('not_found', 'No such thread'), 404);
        const events = resolveEvents();
        const invariants = resolveInvariants();
        const before = await latestScoiFor(events, thread.storyId);
        const actionId = crypto.randomUUID();
        if (body.action === 'annotate' && body.annotation) {
          const inserted = await annotateThreadLenses(forum, threadId, body.annotation);
          if (inserted === 0) {
            return c.json(deny('no_lenses', 'No lens-tagged interpretations to annotate'), 422);
          }
        }
        // Re-computation reflects the action in context state (annotate/
        // merge); separate records the incompatibility for WS-G tooling.
        const after =
          body.action === 'separate'
            ? before
            : await recomputeScoiFor(invariants, events, thread.storyId);
        // A moderator intervention that lowered SCOI must not be inherited
        // by the next contribution as bridge credit: rebaseline any OPEN
        // bridge attempt to the post-action energy.
        if (body.action !== 'separate' && after) {
          const open = await invariants.bridgeAttempts.openForThread(threadId);
          if (open) await invariants.bridgeAttempts.rebaseline(open.attemptId, after.scoi);
        }
        await invariants.scoiActions.insert({
          actionId,
          action: body.action,
          threadId,
          relatedThreadId: body.related_thread_id ?? null,
          storyId: thread.storyId,
          roomId: thread.roomId,
          reasonCode: body.reason_code,
          annotation: body.annotation ?? null,
          actorRef: `steward:${auth.userId}`,
          scoiBefore: before?.scoi ?? null,
          scoiAfter: after?.scoi ?? null,
          createdAt: new Date(invariants.now()).toISOString(),
        });
        const identity = resolveIdentity();
        await identity.audit.append({
          actorUserId: auth.userId,
          eventType: 'scoi_context_action',
          targetRef: threadId,
          context: {
            action: body.action,
            reason_code: body.reason_code,
            related_thread_id: body.related_thread_id ?? null,
            scoi_before: before?.scoi ?? null,
            scoi_after: after?.scoi ?? null,
          },
        });
        return c.json({
          action_id: actionId,
          scoi_before: before?.scoi ?? null,
          scoi_after: after?.scoi ?? null,
          context_state: after?.contextState ?? before?.contextState ?? null,
        });
      },
    )

    .post('/scoi/threads/:threadId/bridge-requests', async (c) => {
      // WS-H.4.2d bridge routing: identify multi-lens participants and open
      // a bridge request with the SCOI baseline. Records only — credit is
      // decided by the durable consumer when a contribution measurably
      // reduces the obstruction.
      const auth = getAuth(c);
      if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
      const threadId = c.req.param('threadId');
      if (!z.string().uuid().safeParse(threadId).success) {
        return c.json(deny('invalid_thread', 'threadId must be a UUID'), 422);
      }
      const forum = resolveForum();
      const ingestion = resolveIngestion();
      const thread = await ingestion.stories.getThreadById(threadId);
      if (!thread) return c.json(deny('not_found', 'No such thread'), 404);
      const roles = thread.roomId
        ? await forum.rooms.stewardRolesFor(thread.roomId, auth.userId)
        : [];
      if (roles.length === 0) return c.json(deny('not_found', 'No such thread'), 404);
      const events = resolveEvents();
      const invariants = resolveInvariants();
      const existing = await invariants.bridgeAttempts.openForThread(threadId);
      if (existing) {
        return c.json(deny('already_open', 'A bridge request is already open'), 409);
      }
      const baseline =
        (await latestScoiFor(events, thread.storyId)) ??
        (await recomputeScoiFor(invariants, events, thread.storyId));
      if (!baseline) {
        return c.json(deny('no_scoi', 'No SCOI measurement available to baseline against'), 422);
      }
      const candidates = await bridgeCandidatesFor(forum, ingestion, threadId);
      const attemptId = crypto.randomUUID();
      await invariants.bridgeAttempts.insert({
        attemptId,
        threadId,
        storyId: thread.storyId,
        status: 'requested',
        requestedBy: `steward:${auth.userId}`,
        candidateUserIds: candidates,
        contributionId: null,
        bridgeUserId: null,
        scoiBaseline: baseline.scoi,
        scoiAfter: null,
        createdAt: new Date(invariants.now()).toISOString(),
        resolvedAt: null,
      });
      const identity = resolveIdentity();
      await identity.audit.append({
        actorUserId: auth.userId,
        eventType: 'bridge_request',
        targetRef: threadId,
        context: { candidate_count: candidates.length, scoi_baseline: baseline.scoi },
      });
      return c.json({
        attempt_id: attemptId,
        scoi_baseline: baseline.scoi,
        candidates,
      });
    })

    .get('/promotions/:invariantType', async (c) => {
      const parsed = invariantTypeSchema.safeParse(c.req.param('invariantType'));
      if (!parsed.success) return c.json(deny('invalid_type', 'unknown invariant type'), 422);
      const invariants = resolveInvariants();
      return c.json({
        invariant_type: parsed.data,
        shadow_status: await invariants.promotionService.statusOf(parsed.data),
        history: await invariants.promotionService.history(parsed.data),
      });
    })

    .post('/promotions', zValidator('json', promotionBodySchema), async (c) => {
      const auth = getAuth(c);
      if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
      const invariants = resolveInvariants();
      const identity = resolveIdentity();
      const body = c.req.valid('json');
      const problem = await invariants.promotionService.apply(
        {
          invariantType: body.invariant_type,
          fromStatus: body.from_status,
          toStatus: body.to_status,
          evidence: {
            shadowDurationDays: body.evidence.shadow_duration_days,
            driftReportRef: body.evidence.drift_report_ref,
            observedCoverage: body.evidence.observed_coverage,
            observedConfidence: body.evidence.observed_confidence,
          },
          owner: body.owner,
          createdAt: new Date(invariants.now()).toISOString(),
        },
        invariants.config().promotionMinShadowDays,
      );
      if (problem !== null) return c.json(deny('promotion_rejected', problem), 422);
      await identity.audit.append({
        actorUserId: auth.userId,
        eventType: 'invariant_promotion_change',
        targetRef: body.invariant_type,
        context: { from: body.from_status, to: body.to_status, owner: body.owner },
      });
      return c.json({
        invariant_type: body.invariant_type,
        shadow_status: await invariants.promotionService.statusOf(body.invariant_type),
      });
    })

    .put('/config', zValidator('json', configBodySchema), async (c) => {
      const auth = getAuth(c);
      if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
      const { key, value } = c.req.valid('json');
      if (!INVARIANTS_CONFIG_KEYS.includes(key)) {
        return c.json(deny('unknown_key', `unknown invariants config key '${key}'`), 422);
      }
      const problem = validateInvariantsConfigValue(key, value);
      if (problem !== null) return c.json(deny('invalid_value', problem), 422);
      const invariants = resolveInvariants();
      await storeInvariantsConfigValue(resolveEvents().configStore, key, value);
      await invariants.reloadConfig();
      await resolveIdentity().audit.append({
        actorUserId: auth.userId,
        eventType: 'invariant_config_change',
        targetRef: key,
        context: { key },
      });
      return c.json({ ok: true, key });
    })

    .get('/regression', (c) => {
      const report = runRegressionSuite();
      return c.json({
        pass: report.pass,
        checks: report.checks.length,
        failures: report.failures,
      });
    });
}
