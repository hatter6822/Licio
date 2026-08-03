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
//   GET  /v1/invariants/admin/reeb/landscape    — the Civic Map: the Reeb
//     attention landscape as a drawable merge tree (WS-H.7.4, SPEC §12.4/§34);
//     observational, with fragile saddles routing into the bridge request below.
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

import {
  INVARIANT_TARGET_TYPES,
  INVARIANT_TYPE_NAMES,
  nextRiskState,
  runRegressionSuite,
} from '@licio/invariants';
import { Hono } from 'hono';
import { z } from 'zod';
import { type EventPipelineServices, getEventPipelineServices } from '../events/services.js';
import { type ForumServices, getForumServices } from '../forum/services.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { getIngestionServices, type IngestionServices } from '../ingestion/services.js';
import { buildCivicMap } from '../invariants/civic-map.js';
import {
  INVARIANTS_CONFIG_KEYS,
  storeInvariantsConfigValue,
  validateInvariantsConfigValue,
} from '../invariants/config.js';
import { runRealtimeTier } from '../invariants/scheduler.js';
import {
  bridgeCandidatesFor,
  latestScoiFor,
  recomputeScoiFor,
} from '../invariants/scoi-actions.js';
import { getInvariantServices, type InvariantPlatformServices } from '../invariants/services.js';
import { zValidator } from '../lib/validate.js';
import { type AuthEnv, authMiddleware, getAuth, requireSteward } from '../middleware/auth.js';
import { denyQueue, stewardActorOf } from '../moderation/authz.js';
import { resolveItemSafetyState } from '../pwatt/scoring.js';

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

// --- Bounds on the invariant-output reads (serving path) --------------------
// `invariant_outputs` grows at roughly two rows per story per window per hour
// and is retained 365 days, so a dashboard must never reach it through
// `listAll()` — that has no predicate and no LIMIT, and the filter/sort/slice
// would then run in JavaScript AFTER every row (three jsonb columns each) had
// been materialized into the Node heap.  `listByTypeSince` pushes the type
// predicate, the `created_at DESC` ordering and the LIMIT into Postgres, and
// the floor lets the planner walk `invariant_outputs_created_idx` backwards
// instead of sorting the table.  These are RECENT-ACTIVITY views, so a window
// is the right shape for them rather than a bound bolted onto "all of history".
const DASHBOARD_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const DASHBOARD_ROW_CAP = 100;
// The public parity export emits ONE statement per row it reads, so its cap
// bounds the RESPONSE as well as the query — it is the only one of the three
// that previously kept (and mapped over) every retained row.
const TRANSPARENCY_LOOKBACK_MS = 90 * 24 * 60 * 60_000;
const TRANSPARENCY_ROW_CAP = 500;
// --- Bounds on the per-room SCOI report -------------------------------------
// The report is a KEYSET page over the room's own threads, so both bounds are
// about the room rather than the platform: how many findings are returned, and
// how far into the room's history the scan will walk looking for them (a room
// with thousands of threads and no SCOI measurements must not turn one console
// load into a table walk).  A page smaller than the ceiling keeps the per-round
// hydration bounded; the scan stops early on a short page, which is the room's
// end.
const SCOI_REPORT_ENTRIES = 100;
const SCOI_REPORT_SCAN_CEILING = 500;
const SCOI_REPORT_PAGE = 50;

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

export function createInvariantsAdminRoutes(
  resolveIdentity: () => IdentityServices = getIdentityServices,
  resolveEvents: () => EventPipelineServices = getEventPipelineServices,
  resolveInvariants: () => InvariantPlatformServices = getInvariantServices,
  resolveForum: () => ForumServices = getForumServices,
  resolveIngestion: () => IngestionServices = getIngestionServices,
) {
  return (
    new Hono<AuthEnv>()
      .use('*', authMiddleware(resolveIdentity))
      .use('*', requireSteward())
      // NOTHING here is cacheable.
      //
      // Every response on this surface is steward-gated and several are tailored
      // to the CALLER's authority — the Civic Map's `thread_id` and
      // `bridge_thread_id` are resolved against the requesting analyst's room
      // steward roles, and its basins carry role-gated titles and exact hourly
      // levels. A cached 200 replayed after an account switch or a role
      // revocation would serve one steward's view to another without
      // `authMiddleware` or the queue check running again, and the Workbox
      // exclusion covers the service worker, not the HTTP cache or a proxy.
      //
      // On the GROUP rather than per route: the next endpoint added here would
      // otherwise have to remember, and every one of them answers a
      // role-dependent question.
      .use('*', async (c, next) => {
        await next();
        c.header('Cache-Control', 'no-store, private');
        c.header('Vary', 'Cookie', { append: true });
      })

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

      // WS-H.1.2f — analyst realtime-tier PREVIEW: run one realtime-capable
      // invariant for a target under the configured latency budget and return the
      // { ok, output | reasonCodes } envelope (the same realtime path WS-I consumes
      // at the ranking boundary; this is its steward-gated inspection surface).
      .post(
        '/realtime-preview',
        zValidator(
          'json',
          z
            .object({
              invariant_type: invariantTypeSchema,
              target_type: z.enum(INVARIANT_TARGET_TYPES),
              target_id: z.string().uuid(),
            })
            .strict(),
        ),
        async (c) => {
          const body = c.req.valid('json');
          const result = await runRealtimeTier(
            resolveInvariants(),
            resolveEvents(),
            body.invariant_type,
            { targetType: body.target_type, targetId: body.target_id },
          );
          return c.json(result);
        },
      )

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
        const outputs = await events.invariantStore.listByTypeSince(
          'MFCI',
          new Date(Date.now() - DASHBOARD_LOOKBACK_MS).toISOString(),
          DASHBOARD_ROW_CAP,
        );
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
          const current =
            (await invariants.mfciRiskStates.get(resolved.targetId))?.state ?? 'normal';
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
        const rows = await resolveEvents().invariantStore.listByTypeSince(
          'GWEI',
          new Date(Date.now() - DASHBOARD_LOOKBACK_MS).toISOString(),
          DASHBOARD_ROW_CAP,
        );
        return c.json({ comparisons: rows });
      })

      .get('/gwei/transparency', async (c) => {
        // Public-safe aggregate parity statements (WS-H.5.2d): no cohort
        // metrics, no suppressed-cell detail — parity vs under-review only.
        // Bounded to the transparency window: this route emits one statement
        // per row, so an unbounded read would also be an unbounded response.
        // ONE clock read for the whole report.  Three separate `Date.now()` /
        // `new Date()` calls gave `period_start`, `period_end` and `generated_at`
        // three different instants, so a report's own window did not quite
        // contain its own generation time — small, but a transparency artifact is
        // supposed to be reproducible from the values it prints.
        const generatedAt = new Date();
        const periodStart = new Date(
          generatedAt.getTime() - TRANSPARENCY_LOOKBACK_MS,
        ).toISOString();
        // BOTH reads bounded by the SAME instant the report prints, for the same
        // reason they share one clock read: an output created while these queries
        // are in flight would otherwise land in a period whose declared
        // `period_end` predates it, and the count could observe a row the list
        // could not — reporting truncation that had not happened.
        const periodEnd = generatedAt.toISOString();
        const store = resolveEvents().invariantStore;
        const rows = await store.listByTypeSince(
          'GWEI',
          periodStart,
          TRANSPARENCY_ROW_CAP,
          periodEnd,
        );
        // STATE THE COVERAGE.  GWEI emits one output per eligible cohort pair
        // per scheduler run, so the cap is reachable in an ordinary period —
        // and a capped list with no denominator reads as a complete account of
        // the window and cannot be reconciled against the logged outputs.  The
        // count is the one fact the truncated read cannot supply about itself.
        const total = await store.countByTypeSince('GWEI', periodStart, periodEnd);
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
        // THE RANGE ACTUALLY COVERED, which is not the range requested.
        // `period_start`/`period_end` describe the 90-day window this report ASKS
        // about, and they said so unconditionally — advertising the full period
        // even when `truncated` was true, with no field naming the oldest row
        // included.  Nothing else could stand in: the per-statement `window` is
        // GWEI's own analysis window, while the cap and the ordering are on
        // `created_at`, so it is not even a proxy.  These two bound what this
        // page holds; the cursor reaches the rest.
        const oldest = rows.at(-1)?.createdAt ?? null;
        const newest = rows.at(0)?.createdAt ?? null;
        return c.json({
          generated_at: generatedAt.toISOString(),
          period_start: periodStart,
          period_end: periodEnd,
          // What the period HELD, against what this response carries.
          total_outputs: total,
          truncated: total > statements.length,
          covered_from: oldest,
          covered_to: newest,
          statements,
        });
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
        // The room must EXIST — and be SERVER-hosted — before any authorization
        // arm: the grants check used to 404 nonexistent rooms incidentally (no
        // grants on a phantom), but the admin bypass would turn a typo/deleted
        // room into a plausible 200 with zero findings, and a member-hosted
        // (p2p) stub has no server-side SCOI surface at all — a 200 empty
        // report would misrepresent it as a clean server room (codex).
        const reportRoom = await forum.rooms.getById(roomId);
        if (reportRoom === null || reportRoom.storageMode !== 'server') {
          return c.json(deny('not_found', 'No such report'), 404);
        }
        // The room's own stewards, or the platform ADMIN (2026-07 final-line-of-
        // defense decision; the outer surface is already requireSteward+MFA).
        const roles = await forum.rooms.stewardRolesFor(roomId, auth.userId);
        if (roles.length === 0 && !auth.roles.includes('admin')) {
          return c.json(deny('not_found', 'No such report'), 404);
        }
        const ingestion = resolveIngestion();
        const events = resolveEvents();
        const invariants = resolveInvariants();
        const lenses = await forum.lenses.listByRoom(roomId);
        const lensNames = new Map(lenses.map((lens) => [lens.lensId, lens.name]));
        // Page the ROOM's OWN threads, rather than the platform's 200 most
        // recent stories filtered down to this room afterwards.
        //
        // The budget was spent before the room was considered: on a platform
        // with any volume the recent 200 are dominated by the busiest rooms, so
        // a quiet room's threads never appeared in them and its stewards read an
        // empty SCOI report — which is indistinguishable from "no divergent
        // conversations here" and is in fact "nothing of yours was looked at".
        // The room is a column on the thread, so the restriction belongs in the
        // read; what is bounded now is how much of the ROOM is scanned.
        const entries = [];
        let threadCursor: { createdAt: string; threadId: string } | null = null;
        let scanned = 0;
        // COMPLETE until a bound stops the walk. An empty report and a
        // truncated one are the same list, and a steward reading "no divergent
        // conversations" off a scan that stopped at its ceiling is exactly the
        // ambiguity this room-scoped paging exists to remove — so the answer
        // says which it was.
        let complete = false;
        scan: while (scanned < SCOI_REPORT_SCAN_CEILING && entries.length < SCOI_REPORT_ENTRIES) {
          const threads = await ingestion.stories.listThreadsByRoom(
            roomId,
            threadCursor,
            SCOI_REPORT_PAGE,
          );
          if (threads.length === 0) {
            complete = true;
            break;
          }
          scanned += threads.length;
          const stories = await ingestion.stories.getByIds(threads.map((t) => t.storyId));
          const last = threads[threads.length - 1];
          threadCursor =
            last === undefined ? null : { createdAt: last.createdAt, threadId: last.threadId };
          for (const thread of threads) {
            const story = stories.get(thread.storyId);
            if (!story) continue;
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
              // The §10.5 "Bridge attempts" branch (the WS-H.4.2d credit surface).
              bridge_attempts: await invariants.bridgeAttempts.listForThread(thread.threadId, 10),
            });
            if (entries.length >= SCOI_REPORT_ENTRIES) break scan;
          }
          if (threads.length < SCOI_REPORT_PAGE) {
            // A short page IS the end of the room.
            complete = true;
            break;
          }
        }
        return c.json({
          room_id: roomId,
          reports: entries,
          // `complete: false` ⇒ the room has threads this scan never looked at,
          // so an empty or short list is a partial answer rather than a clean
          // room. `examined` is how many threads were walked, not how many are
          // reported.
          scan: { complete, examined: scanned },
        });
      })

      .get('/reeb/landscape', async (c) => {
        // WS-H.7.4 Civic Map (SPEC §12.4, §34): the Reeb attention landscape
        // as a drawable merge tree, for the console's Integrity tab. Strictly
        // OBSERVATIONAL — the only action it enables is the §12.4 bridge
        // prompt, which goes through the existing SCOI bridge-request route
        // below with its own room-steward authorization.
        //
        // INTEGRITY-QUEUE gated, not merely steward-gated. The enclosing
        // `requireSteward()` is a PLATFORM-role check, so on its own it would
        // hand per-story titles and exact hourly event-count levels to
        // evidence-only, appeals-only and community stewards. This surface
        // answers the same question as the coordinated-report incidents it
        // renders beside, and that queue is ROLE_INTEGRITY — so the landscape
        // takes the same doctrine bar, through the same helper, rather than
        // inventing a second standard for one analyst view.
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const queueDenial = denyQueue(stewardActorOf(auth), 'integrity-queue');
        if (queueDenial) return c.json(deny(queueDenial.code, queueDenial.message), 403);
        // An empty landscape is a real state (a quiet hour, a fresh install),
        // so it answers 200 with an explicit `null` rather than 404 — the panel
        // renders "nothing to map yet", and a steward can tell that apart from
        // a broken endpoint.
        // The bridge target is resolved AGAINST THIS CALLER, mirroring the
        // POST below exactly: a room-hosted server thread whose room this
        // analyst stewards, or platform admin. Reading the landscape is a
        // ROLE_INTEGRITY power; ACTING on a room's conversation is not, so a
        // thread id published here without that check would render a control
        // that deterministically 404s.
        const forum = resolveForum();
        const map = await buildCivicMap(
          resolveEvents(),
          resolveIngestion(),
          Date.now(),
          async (threadId, roomId, storyId) => {
            if (roomId === null) return false;
            const room = await forum.rooms.getById(roomId);
            if (room === null || room.storageMode !== 'server') return false;
            const authorized = auth.roles.includes('admin')
              ? true
              : (await forum.rooms.stewardRolesFor(roomId, auth.userId)).length > 0;
            if (!authorized) return false;
            // …AND a SCOI baseline must exist. The bridge POST refuses with
            // `422 no_scoi` when the conversation has interpretations from fewer
            // than two lenses, so a target published without one is a control
            // that fails every time it is used. `void threadId` — the baseline
            // is a property of the STORY the thread belongs to.
            // …and no request may already be OPEN on it. The POST answers
            // `409 already_open`, and the map is not re-fetched after a
            // successful bridge, so the button stayed live and every later click
            // failed the same way. Checked first: it is a single indexed read,
            // and a baseline recompute is not.
            const invariants = resolveInvariants();
            if (await invariants.bridgeAttempts.openForThread(threadId)) return false;
            const baseline =
              (await latestScoiFor(resolveEvents(), storyId)) ??
              (await recomputeScoiFor(invariants, resolveEvents(), storyId));
            return baseline !== null;
          },
        );
        return c.json({ landscape: map }, 200);
      })

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
        // Bridge requests are ROOM-scoped: a roomless (global) thread has no
        // steward surface at all, for admin included — without this the admin
        // arm would open a bridge request the grants check made unreachable.
        // The room must also still EXIST and be SERVER-hosted (codex: an
        // orphaned/migration-drift thread whose room row is gone — or points at
        // a member-hosted p2p stub — has no steward or report surface;
        // mirroring the reports route's guard).
        const bridgeRoom = thread.roomId === null ? null : await forum.rooms.getById(thread.roomId);
        if (bridgeRoom === null || bridgeRoom.storageMode !== 'server') {
          return c.json(deny('not_found', 'No such thread'), 404);
        }
        const roles = await forum.rooms.stewardRolesFor(thread.roomId, auth.userId);
        // Same admin arm as the room SCOI reports above.
        if (roles.length === 0 && !auth.roles.includes('admin')) {
          return c.json(deny('not_found', 'No such thread'), 404);
        }
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
      })
  );
}
