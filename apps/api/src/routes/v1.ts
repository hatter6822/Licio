// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Versioned BFF contract surface (SPEC §23.2) the PWA's Hono RPC client types
// against (WS-C.3.1). Routes are defined with method chaining so the exported
// type captures every path, method, input, and response — a client/server
// contract mismatch becomes a `tsc` build failure.
//
// Ownership: push (WS-C.2.4a), notification preferences (WS-C.2.4c), attention
// ingestion (WS-C.4.4), telemetry/RUM ingest (WS-C observability), feature flags
// (WS-C.1.3c), and settings sync are implemented here. The read-model data
// endpoints (feed, story, thread, room, signal-ledger) are typed CONTRACTS whose
// production data layer is owned by later workstreams (WS-G/H/J); until then they
// serve a deterministic in-memory demo dataset (see `lib/demo-data.ts`) so the PWA
// has stable, structurally honest content to render — clearly fixture data, never
// a fabricated production source of truth.

import {
  type AttentionIngestAck,
  attentionAggregateBatchSchema,
  attentionIngestAckSchema,
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_USER_SETTINGS,
  deriveStorySafetyState,
  FAIL_CLOSED_FLAGS,
  type FeedResponse,
  featureFlagsResponseSchema,
  feedQuerySchema,
  feedResponseSchema,
  isSentinelTopicId,
  LEGACY_DISTRIBUTION_REASON,
  legacyPreservingFeedMode,
  legacyRatingLabel,
  notificationPreferencesSchema,
  notificationsResponseSchema,
  okAckSchema,
  pushRegisterRequestSchema,
  type SignalLedgerEntry,
  type SignalLedgerResponse,
  signalLedgerResponseSchema,
  storyDetailSchema,
  type TelemetryIngestAck,
  telemetryBatchSchema,
  telemetryIngestAckSchema,
  userSettingsSchema,
  uuidSchema,
  vapidPublicKeyResponseSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  aggregateBelongsToSession,
  aggregateToCanonicalEvent,
  ingestAttentionEvents,
  OFFLINE_SYNC_ACCEPTANCE,
} from '../events/ingest.js';
import { getEventPipelineServices } from '../events/services.js';
import type { SignalLedgerRecord } from '../events/stores.js';
import {
  EMPTY_CARD_SIGNALS,
  type StoryCardSignals,
  storyCardSignals,
} from '../forum/card-signals.js';
import { roomContentVisibleToUser, storyReadableByUser } from '../forum/rooms.js';
import { getForumServices } from '../forum/services.js';
import { accountRef, sha256Hex } from '../identity/crypto.js';
import { getIdentityServices } from '../identity/services.js';
import { readSessionToken, validateSession } from '../identity/sessions.js';
import { loadContentFlags } from '../ingestion/content-flags.js';
import { getIngestionServices } from '../ingestion/services.js';
import type { StoryRecord, ThreadShellRecord } from '../ingestion/stores.js';
import { tryGetInvariantServices } from '../invariants/services.js';
import { getKnomosisServices, knomosisServicesConfigured } from '../knomosis/services.js';
import { DEMO_FEED, demoStory } from '../lib/demo-data.js';
import { makeMediaUrlMinter } from '../lib/media-urls.js';
import {
  getPreferences,
  getVapidConfig,
  registerSubscription,
  removeSubscription,
  setPreferences,
} from '../lib/push-service.js';
import { rateLimit } from '../lib/rate-limit.js';
import { replyNotifications } from '../lib/reply-notifications.js';
import { feedMediaOf } from '../lib/story-media.js';
import { getUserSettingsStore } from '../lib/user-settings.js';
import { zValidator } from '../lib/validate.js';
import { type AuthEnv, authMiddleware, getAuth } from '../middleware/auth.js';
import { serveFeed } from '../ranking/service.js';
import { getRankingServices } from '../ranking/services.js';
import { getTelemetryServices } from '../telemetry/service.js';
import { createAiGovernanceAdminRoutes } from './ai-governance-admin.js';
import { createAiGovernancePublicRoutes } from './ai-governance-public.js';
import { createAuthRoutes } from './auth.js';
import { createComplianceRoutes } from './compliance.js';
import { createEventsRoutes } from './events.js';
import { createForumRoutes } from './forum.js';
import { createGovernanceRoutes } from './governance.js';
import { createIngestionAdminRoutes } from './ingestion-admin.js';
import { createInvariantsAdminRoutes } from './invariants-admin.js';
import { createInvariantsPublicRoutes } from './invariants-public.js';
import { createKnomosisRoutes } from './knomosis.js';
import { createModelHubRoutes } from './model-hub.js';
import { createModerationConsoleRoutes } from './moderation-console.js';
import { createPrivacyRoutes } from './privacy.js';
import { createRankingAdminRoutes } from './ranking-admin.js';
import { createRoomGovernanceSimRoutes } from './room-governance.js';
import { createRoomsRoutes } from './rooms.js';
import { createStoriesRoutes } from './stories.js';
import { createTreasuryGovernanceRoutes } from './treasury-governance.js';
import { createTrustSafetyRoutes } from './trust-safety.js';
import { createWalletRoutes } from './wallet.js';

/**
 * OPTIONAL session resolution for public-but-personalizable surfaces (the
 * feed): a valid `__Host-sid` session yields the user id; anything else —
 * absent cookie, expired session, store outage — yields anonymous. Failures
 * degrade to the signed-out feed, never to an error (and never to access).
 */
async function resolveOptionalUserId(cookieHeader: string | undefined): Promise<string | null> {
  const token = readSessionToken(cookieHeader);
  if (token === undefined) return null;
  try {
    const services = getIdentityServices();
    const validated = await validateSession(services.sessions, token);
    return validated?.record.user_id ?? null;
  } catch {
    return null;
  }
}

/**
 * The settings-sync key (SPEC §23.2): the USER id when signed in — so settings
 * survive re-login and sync across devices — else the session token's SHA-256
 * (the degraded path when a valid `__Host-sid` session cannot be resolved to a
 * user, e.g. a transient store outage).  A cookieless visitor gets `undefined`
 * and is never persisted server-side (the client's local persistence owns that
 * state; the old shared 'anonymous' fallback was a cross-user state bleed).
 *
 * The fallback key is HASHED, never the raw cookie value.  The cookie carries a
 * BEARER session token, and these stores are durable (the production boot swaps
 * in the Drizzle adapter), so a raw key would put a live credential in plaintext
 * in a table — reachable through backups, replicas, log exports, and keyspace
 * scans.  Hashing keeps the key exactly as stable and as distinct per session
 * while making a leaked row useless: the session store itself only ever persists
 * `sha256(token)`, and `middleware/csrf.ts` hashes the same value for the same
 * reason.  This is that invariant, applied here too.
 */
async function settingsKey(cookieHeader: string | undefined): Promise<string | undefined> {
  const userId = await resolveOptionalUserId(cookieHeader);
  if (userId !== null) return userId;
  const token = readSessionToken(cookieHeader);
  return token === undefined ? undefined : sha256Hex(token);
}

const notFound = { error: { code: 'not_found', message: 'Resource not found' } } as const;

/** The live safety posture a story-detail read needs to derive its SPEC §22.1
 *  safety state IDENTICALLY to the WS-I feed. */
interface StoryReadSignals {
  safetyState: ReturnType<typeof deriveStorySafetyState>;
}

/**
 * Assemble the live safety posture for ONE story from STORED shadow outputs (a
 * detail read never triggers invariant computation): the item safety state +
 * MFCI risk + thread posture, fed through the SAME shared
 * `deriveStorySafetyState` the feed uses, so the surfaces agree by
 * construction.  (The SCOI-divergence and PWAtt-attention reads that used to
 * live here fed only the removed §5.6 rating label; the reader-facing SCOI
 * surface is the story page's "Where interpretations differ" drawer.)
 */
async function assembleStoryReadSignals(
  story: StoryRecord,
  thread: ThreadShellRecord | null,
): Promise<StoryReadSignals> {
  const events = getEventPipelineServices();
  // Invariants are a SOFT dependency: when the platform is not wired, MFCI risk
  // is simply absent (the read still serves).
  const invariants = tryGetInvariantServices();
  const [safeties, mfciRisk] = await Promise.all([
    events.safetyStore.getMany([story.storyId]),
    invariants ? invariants.mfciRiskStates.get(story.storyId) : Promise.resolve(null),
  ]);
  const safetyState = deriveStorySafetyState({
    frozen: safeties.get(story.storyId)?.safetyState === 'frozen',
    mfciRiskState: mfciRisk?.state,
    threadSafetyState: thread?.safetyState,
  });
  return { safetyState };
}

/** Map a REAL ingested story onto the established WS-C story-detail wire
 *  shape (the client validates against storyDetailSchema; real submissions
 *  appear through the same contract the demo fixtures established). The card
 *  signals + safety state derive from the SAME shared functions the feed uses. */
function realStoryToDetail(
  story: StoryRecord,
  thread: { threadId: string } | null,
  viewer: { isOwner: boolean; roomVisibility: 'public' | 'private' },
  signals: StoryReadSignals,
  cardSignals: StoryCardSignals,
) {
  const excerptWords = story.excerpt === null ? 0 : story.excerpt.split(/\s+/).length;
  return {
    story_id: story.storyId,
    title: story.title,
    source: story.publisher ?? story.canonicalUrl ?? 'Community submission',
    ...(story.canonicalUrl !== null ? { url: story.canonicalUrl } : {}),
    visibility: story.visibility,
    media: feedMediaOf(story, makeMediaUrlMinter()),
    // Best-effort estimate from the bounded excerpt (the full body is never
    // stored, WS-F.1.4f) — a floor, not a measurement.
    reading_minutes: Math.max(1, Math.ceil(excerptWords / 200)),
    // SPEC §5.6 — the compact card signals (shared derivation with the feed):
    // the sourced-comment count and the WS-T corrections tally.
    sources_count: cardSignals.sourced,
    corrections: cardSignals.corrections,
    // DEPRECATED rollout compat: pre-redesign cached bundles REQUIRE
    // rating_label; emit the legacy approximation until they age out (the
    // detail path no longer reads PWAtt, so the attention gate floors at
    // `new` — no pre-redesign detail surface ever rendered the label).
    rating_label: legacyRatingLabel({
      lifecycleState: story.lifecycleState,
      safetyState: signals.safetyState,
    }),
    // DEPRECATED rollout compat: pre-removal cached bundles REQUIRE a
    // non-empty distribution_reason (see LEGACY_DISTRIBUTION_REASON).
    distribution_reason: LEGACY_DISTRIBUTION_REASON,
    context_chips: [],
    safety_state: signals.safetyState,
    // WS-T dispute posture — powers the "Challenged"/"Incorrect" badge on the
    // story detail page (parity with the feed card projection).
    dispute_status: story.disputeStatus ?? 'none',
    // WS-T settle marker (SPEC §15.4): emitted only when TRUE (parity with the
    // feed projection). A settled story is always `validated`; the detail banner
    // renders the terminal "Settled" state.
    ...(story.settledAt != null ? { dispute_settled: true } : {}),
    body_summary: story.excerpt ?? '',
    thread_id: thread?.threadId ?? null,
    // The home room (WS-G.2.2): powers the client's lens composer + conversation
    // filter (the interpretation lenses are per-room).
    room_id: story.roomId,
    // A freshly submitted story carries the UNCLASSIFIED sentinel until the WS-K
    // validator runs; it is NOT a subject topic, so strip it from the wire (parity
    // with the routes/stories.ts detail projection) — never let a client/offline
    // cache persist the sentinel as a real topic (SPEC §24.1).
    topic_ids: story.topicIds.filter((id) => !isSentinelTopicId(id)).slice(0, 8),
    // WS-Q.5.4a — the owner-only author visibility control + widen eligibility.
    is_owner: viewer.isOwner,
    room_visibility: viewer.roomVisibility,
  };
}

/** Scoring annotation → the §5.3 anti-signal name shown in the ledger. */
const ANNOTATION_TO_LEDGER_ANTI_SIGNAL: Readonly<
  Record<string, NonNullable<SignalLedgerEntry['anti_signals']>[number]>
> = {
  source_free_accusation_downweight: 'source_free_accusation',
  rapid_repetition_dampened: 'rapid_repetition',
  coordinated_burst_placeholder_dampening: 'coordinated_burst',
  harassment_cascade_review: 'harassment_cascade',
};

/** Map a stored Signal Ledger row to the wire entry (validated on egress). */
function toLedgerEntry(row: SignalLedgerRecord): SignalLedgerEntry {
  const signals = row.signals as {
    active_dwell_bucket?: string;
    source_opened?: boolean;
    context_opened?: boolean;
    reply_depth_bucket?: string;
    return_visit_count_bucket?: string;
    saved_for_later?: boolean;
    cap_reached?: boolean;
  };
  const antiSignals = [
    ...new Set(
      row.antiSignals
        .map((annotation) => ANNOTATION_TO_LEDGER_ANTI_SIGNAL[annotation])
        .filter((mapped): mapped is NonNullable<typeof mapped> => mapped !== undefined),
    ),
  ];
  return {
    item_id: row.itemId,
    story_title: row.storyTitle,
    recorded_at: row.recordedAt,
    active_dwell_bucket: (signals.active_dwell_bucket ??
      'none') as SignalLedgerEntry['active_dwell_bucket'],
    source_opened: signals.source_opened ?? false,
    context_opened: signals.context_opened ?? false,
    reply_depth_bucket: (signals.reply_depth_bucket ??
      'none') as SignalLedgerEntry['reply_depth_bucket'],
    return_visit_count_bucket: (signals.return_visit_count_bucket ??
      'none') as SignalLedgerEntry['return_visit_count_bucket'],
    saved_for_later: signals.saved_for_later ?? false,
    // OMIT cap status when the server does not know it (the §22.1 wire carries
    // buckets, not the cap flag): asserting `false` from ignorance would make
    // the "counting stopped" disclosure permanently unreachable. Only a client-
    // emitted cap flag ever populates it.
    ...(signals.cap_reached !== undefined ? { cap_reached: signals.cap_reached } : {}),
    anti_signals: antiSignals,
    pwatt_v0_score: row.pwattScore,
    summary: row.summary,
  };
}

/**
 * Build the v1 router. Every route is chained so `typeof createV1Routes()` is the
 * precise contract the RPC client consumes. The env is AuthEnv (a superset of
 * AppEnv) so per-route auth middleware can attach the session context.
 */
export function createV1Routes() {
  return (
    new Hono<AuthEnv>()
      // --- Feed (WS-I ranking pipeline, SPEC §13.3/§23.2) -------------------
      // The eight-stage pipeline serves whenever ANY real story exists:
      // candidate generation → feature join → safety filter → constrained
      // PWAtt scoring → diversification → decision log → explanations →
      // FeedItem mapping. The kill switch routes through the safe
      // chronological fallback; the user sort modes (`new`/`sources`/
      // `debates`/`rising`) serve their complete deterministic orderings
      // over the same safety-filtered set inside the service (WS-I.4.1a/b).
      // With an EMPTY story store (fresh dev boot, contract tests) the
      // legacy WS-C demo fixture serves unchanged — clearly fixture data,
      // outside the ranking pipeline, and logged as demo serving.
      .get('/feed', zValidator('query', feedQuerySchema), async (c) => {
        // Fixture serving is a DEV/TEST affordance only: a production boot with
        // an empty store serves an empty feed, never demo data — so the FREE
        // predicate gates the store read rather than the other way round, and a
        // production feed request issues no query that cannot change its answer.
        // (`listRecent` uses `.select()`, so it also drags the row's generated
        // `search_tsv` back with it.)
        if (
          process.env['NODE_ENV'] !== 'production' &&
          (await getIngestionServices().stories.listRecent(1)).length === 0
        ) {
          const response: FeedResponse = { items: [...DEMO_FEED], nextCursor: null };
          return c.json(feedResponseSchema.parse(response));
        }
        const ranking = getRankingServices();
        const { mode, topic, cursor } = c.req.valid('query');
        // `?topic=` serves the WS-I TOPIC surface: the pool scopes to the
        // topic and the profile selector derives its sensitivity from it.
        // `?cursor=` is the previous page's request id (seen-aware
        // pagination); unknown/expired cursors serve the first page.
        const served = await serveFeed(ranking, {
          userId: await resolveOptionalUserId(c.req.header('cookie')),
          surface: topic !== undefined ? 'topic' : 'front_page',
          surfaceRoomId: null,
          surfaceTopicId: topic ?? null,
          mode,
          cursor: cursor ?? null,
        });
        const response: FeedResponse = {
          items: served.items,
          nextCursor: served.nextCursor,
          request_id: served.requestId,
        };
        return c.json(feedResponseSchema.parse(response));
      })
      // --- Room feed (WS-I room surface, SPEC §13.2/§16.2) ------------------
      // The ranked feed of ONE room. CONTENT visibility is the WS-G bar
      // (`roomContentVisibleToUser`): public rooms serve signed-out; a
      // restricted/expert-led room serves only ACTIVE members or stewards —
      // and an unauthorized request reads 404, never 403 (no existence
      // oracle beyond what the room directory already discloses).
      .get(
        '/rooms/:roomId/feed',
        zValidator('param', z.object({ roomId: uuidSchema })),
        zValidator('query', feedQuerySchema),
        async (c) => {
          const { roomId } = c.req.valid('param');
          const { mode, cursor } = c.req.valid('query');
          const userId = await resolveOptionalUserId(c.req.header('cookie'));
          const forum = getForumServices();
          const room = await forum.rooms.getById(roomId);
          if (room === null) return c.json(notFound, 404);
          // WS-S.1.3 — a Private P2P room's feed is rendered from LOCAL decrypted
          // reducer state, never the server (the §8 non-storage contract).
          //
          // It answers the UNKNOWN-ROOM 404, not a distinctive 409. §23.5 allows
          // either, and the distinctive one is an oracle: anyone holding or
          // guessing an `unlisted` `room_server_id` could confirm the room exists
          // here, which is the identical-404 contract of
          // `GET /v1/private-rooms/:id/bootstrap` undone through another
          // endpoint. `roomContentVisibleToUser` refuses a p2p shell before any
          // visibility rule, so this is the shared predicate's answer rather than
          // a branch this route has to remember.
          if (!(await roomContentVisibleToUser(forum, room, userId))) {
            return c.json(notFound, 404);
          }
          const served = await serveFeed(getRankingServices(), {
            userId,
            surface: 'room',
            surfaceRoomId: roomId,
            surfaceTopicId: null,
            mode,
            cursor: cursor ?? null,
          });
          const response: FeedResponse = {
            items: served.items,
            nextCursor: served.nextCursor,
            request_id: served.requestId,
          };
          return c.json(feedResponseSchema.parse(response));
        },
      )
      .get(
        '/stories/:storyId',
        zValidator('param', z.object({ storyId: uuidSchema })),
        async (c) => {
          const { storyId } = c.req.valid('param');
          // REAL ingested stories first (WS-F); demo fixtures remain the
          // fallback contract data until WS-G/I own the read models.
          const ingestion = getIngestionServices();
          const real = await ingestion.stories.getById(storyId);
          if (real) {
            // Takedown-removed / safety-hidden stories are not served (404,
            // not 403 — no existence oracle; WS-F.1.4f).
            if (real.hiddenState !== null) return c.json(notFound, 404);
            // WS-Q.3.2 — the item read bar: a room_only story in a private room
            // is 404 to outsiders/pending applicants (no oracle); a public story
            // is readable by anyone who can reach its (public) room.
            const forum = getForumServices();
            const userId = await resolveOptionalUserId(c.req.header('cookie'));
            const room = await forum.rooms.getById(real.roomId);
            if (room === null || !(await storyReadableByUser(forum, real, room, userId))) {
              return c.json(notFound, 404);
            }
            const thread = await ingestion.stories.getThreadByStoryId(storyId);
            const events = getEventPipelineServices();
            // The card signals share the removal-aware derivation with the
            // feed: a moderation-removed thread yields the neutral signals
            // (never counts for a conversation the reader cannot open).
            const [signals, cardSignalsByStory] = await Promise.all([
              assembleStoryReadSignals(real, thread),
              storyCardSignals(
                forum,
                events.safetyStore,
                new Map([[storyId, thread?.threadId ?? null]]),
              ),
            ]);
            // WS-G.3.3 — a WS-J moderation removal makes the thread routes 404
            // (threadReadableToUser) and drops it from the directory; suppress
            // the id here too so the story page renders no conversation link to a
            // guaranteed-404 thread.
            const linkThread =
              thread !== null &&
              (await events.safetyStore.get(thread.threadId))?.safetyState === 'removed'
                ? null
                : thread;
            return c.json(
              storyDetailSchema.parse(
                realStoryToDetail(
                  real,
                  linkThread,
                  {
                    isOwner: userId !== null && userId === real.submittedBy,
                    roomVisibility: room.visibility,
                  },
                  signals,
                  cardSignalsByStory.get(storyId) ?? EMPTY_CARD_SIGNALS,
                ),
              ),
            );
          }
          // The demo-fixture read is a DEV/TEST affordance only (parity with
          // the /feed fixture gate above): production reads 404 on a miss.
          const story = process.env['NODE_ENV'] !== 'production' ? demoStory(storyId) : null;
          return story ? c.json(storyDetailSchema.parse(story)) : c.json(notFound, 404);
        },
      )
      // Threads, contributions, rooms, and lenses are REAL WS-G read/write
      // models now (routes/forum.ts + routes/rooms.ts, mounted below).
      // Owner-only (WS-E.2.1d): the ledger returns ONLY the authenticated
      // user's entries — there is no path to another user's ledger (the
      // endpoint takes no user parameter), and it is excluded from public
      // APIs and search surfaces by construction.
      .get(
        '/signal-ledger',
        authMiddleware(),
        zValidator('query', z.object({ cursor: z.string().min(1).max(512).optional() })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(notFound, 404);
          const events = getEventPipelineServices();
          const { cursor } = c.req.valid('query');
          const page = await events.ledgerStore.listForUser(auth.userId, 50, cursor);
          const response: SignalLedgerResponse = {
            items: page.entries.map(toLedgerEntry),
            nextCursor: page.nextCursor,
          };
          return c.json(signalLedgerResponseSchema.parse(response));
        },
      )

      // --- Identity & privacy (WS-D) ----------------------------------------
      .route('/auth', createAuthRoutes())
      .route('/privacy', createPrivacyRoutes())

      // --- Event pipeline (WS-E) --------------------------------------------
      .route('/events', createEventsRoutes())

      // --- Ingestion, source model, and search (WS-F) ------------------------
      // POST /stories, GET /search, POST /takedowns, claim/evidence/source
      // reads — plus the steward admin surface.
      .route('/', createStoriesRoutes())
      .route('/ingestion/admin', createIngestionAdminRoutes())

      // --- Invariant services (WS-H) -----------------------------------------
      // Public SCOI/MERI read surfaces + the steward/analyst admin surface.
      .route('/', createInvariantsPublicRoutes())
      .route('/invariants/admin', createInvariantsAdminRoutes())

      // --- Ranking and distribution (WS-I) ------------------------------------
      // Decision-log audit queries, replay, the kill switch, validated
      // config writes, and the profile registry (steward + MFA).
      .route('/ranking/admin', createRankingAdminRoutes())

      // --- Forum, conversation, rooms, and lenses (WS-G) ----------------------
      // The story's comment section (+ its SSE stream), contributions and the
      // per-comment anchor, the WS-T debate arenas, feed preferences, uploads,
      // the drainer blocklist, room listing/creation/detail/subscription, and
      // lenses.  (The thread overview and per-branch reads were retired with
      // the WS-T comment remodel — SPEC §6.4/§24.3.)
      .route('/', createForumRoutes())
      .route('/', createRoomsRoutes())

      // --- Trust & safety (WS-J) ----------------------------------------------
      // User-facing: reports, blocks, mutes, appeals, the unauthenticated
      // support contact, and the moderation-notice inbox.  Console: the
      // role-gated report/appeal queues, review panels, action palette, audit
      // viewer, and transparency export.
      .route('/', createTrustSafetyRoutes())
      .route('/moderation', createModerationConsoleRoutes())

      // --- AI and model governance (WS-K) -------------------------------------
      // Public: model-card lookup (transparency), translation, and summary/
      // translation reports.  Admin: AI-team model lifecycle (register/version/
      // evaluate/deploy/deprecate) + the deploy gate, runtime config, the
      // inventory/blocked/runtime read surfaces, and the steward review queue.
      .route('/', createAiGovernancePublicRoutes())
      .route('/ai/admin', createAiGovernanceAdminRoutes())

      // --- AI-governed rooms (WS-U) -------------------------------------------
      // The elected-steward seat + elections, the community model/prompt registry
      // (propose / list / member-downloadable artifact / approve), and the
      // "governed by" agent view.  Steward-only writes are enforced by the
      // service; treasury powers stay behind the fail-closed crypto flag.
      .route('/', createGovernanceRoutes())
      // WS-U model candidacy: the member hub-model READ surface (search +
      // revision-pinning resolve), BFF-proxied so the browser never reaches a
      // third party; 503 fail-closed when GOVERNANCE_MODEL_HUB=off.
      .route('/model-hub', createModelHubRoutes())

      // --- Knomosis gateway, wallets, and receipts (WS-L) ---------------------
      // Wallet link/unlink/list/risk (SIWE + abuse limits), the pinned
      // deployment/manifest reads, the preflight → submit pipeline with the
      // §23.5 state machine, ranking-firewalled standing reads, private
      // receipts, the kill-switch admin, and the K1 governance-simulation
      // surface (proposals/treasury/audit-log/comprehension/readiness).
      // Everything fails closed behind the runtime crypto/governance flags.
      .route('/', createWalletRoutes())
      .route('/knomosis', createKnomosisRoutes())
      .route('/', createRoomGovernanceSimRoutes())
      .route('/', createTreasuryGovernanceRoutes())

      // --- Compliance (WS-N) --------------------------------------------------
      // Feature availability + identity-free region declaration + risk
      // disclosures (user surface); jurisdiction-policy admin, cases, the
      // fraud queue, wallet-risk pins (compliance role); SAR/STR + lawful
      // access + disclosure publication (counsel).  All fail-closed.
      .route('/compliance', createComplianceRoutes())

      // --- Settings sync (SPEC §23.2 /feed/preferences) ---------------------
      .get('/settings', async (c) => {
        const key = await settingsKey(c.req.header('cookie'));
        if (key === undefined) return c.json(DEFAULT_USER_SETTINGS);
        return c.json((await getUserSettingsStore().get(key)) ?? DEFAULT_USER_SETTINGS);
      })
      .patch('/settings', zValidator('json', userSettingsSchema.partial()), async (c) => {
        const key = await settingsKey(c.req.header('cookie'));
        const current =
          key === undefined
            ? DEFAULT_USER_SETTINGS
            : ((await getUserSettingsStore().get(key)) ?? DEFAULT_USER_SETTINGS);
        const patch = c.req.valid('json');
        // Feed-mode writes store the legacy-preserving spelling (rollout
        // compat: a stale bundle for the same account validates this
        // response/store echo against the old mode enum; lossless for
        // best/new — see legacyPreservingFeedMode).
        const merged = userSettingsSchema.parse({
          ...current,
          ...patch,
          ...(patch.feed_mode !== undefined
            ? { feed_mode: legacyPreservingFeedMode(patch.feed_mode) }
            : {}),
        });
        if (key !== undefined) await getUserSettingsStore().set(key, merged);
        return c.json(merged);
      })

      // --- Feature flags (WS-C.1.3c, fail-closed) ---------------------------
      .get('/feature-flags', async (c) => {
        // Crypto/governance stay fail-closed (per-region enablement is WS-D/
        // compliance; SPEC §0.5). The WS-Q content surface IS populated: the
        // fail-closed rollout flags + the video caps the composer pre-checks
        // against (the server remains authoritative).
        const events = getEventPipelineServices();
        const ingestion = getIngestionServices();
        const flags = await loadContentFlags(events.configStore);
        const cfg = ingestion.config();
        // WS-L: crypto/governance/region flags come from the SINGLE runtime
        // source of truth (knomosis.* config; fail-closed false).  An
        // unconfigured container serves the hard fail-closed defaults.
        const knomosisFlags = knomosisServicesConfigured()
          ? (() => {
              const kc = getKnomosisServices().config();
              return {
                cryptoEnabled: kc.cryptoEnabled,
                governanceEnabled: kc.governanceEnabled,
                regionFlags: kc.regionFlags,
              };
            })()
          : {};
        return c.json(
          featureFlagsResponseSchema.parse({
            ...FAIL_CLOSED_FLAGS,
            ...knomosisFlags,
            content: {
              media_posts_enabled: flags.mediaPostsEnabled,
              in_room_visibility_enabled: flags.inRoomVisibilityEnabled,
              binary_visibility_ui: flags.binaryVisibilityUi,
              video_max_bytes: Math.min(
                cfg.videoMaxBytes,
                FAIL_CLOSED_FLAGS.content.video_max_bytes,
              ),
              video_max_seconds: cfg.videoMaxSeconds,
            },
          }),
        );
      })

      // --- Attention ingestion (WS-C.4.4 → attention.aggregate, WS-E.1.3) ---
      // The WS-C client batch wire. Each §22.1 aggregate is converted into a
      // canonical single-item `attention.aggregate` event and flows through
      // the SAME hardened pipeline as POST /v1/events/attention (WS-E.1.3e:
      // identical auth, ownership, replay, rate-limit, and privacy guards) —
      // with the OFFLINE acceptance window, because the durable pending queue
      // replays batches when connectivity returns (§6.9). Replay safety never
      // depends on the window: every aggregate_id is a single-use nonce AND
      // the event store's id-uniqueness rejects re-ingestion forever, so a
      // replayed batch acks `accepted: 0` (idempotent retry semantics for the
      // sync queue) instead of double-counting.
      .post(
        '/attention/aggregates',
        authMiddleware(),
        // Per-user sliding-window rate limit (one request = one hit), BEFORE
        // body validation so malformed batches consume the same budget as
        // valid ones (WS-E.1.3e: identical guard order on both surfaces).
        async (c, next) => {
          const auth = getAuth(c);
          if (!auth) return c.json(notFound, 404);
          const events = getEventPipelineServices();
          const identity = getIdentityServices();
          const decision = await events.ingestLimiter.hit(
            accountRef(identity.config.masterSecret, auth.userId),
            events.now(),
          );
          if (!decision.allowed) {
            c.header('Retry-After', String(decision.retryAfterSec));
            return c.json(
              { error: { code: 'rate_limited', message: 'Too many attention uploads' } },
              429,
            );
          }
          await next();
        },
        zValidator('json', attentionAggregateBatchSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(notFound, 404);
          const events = getEventPipelineServices();
          const identity = getIdentityServices();
          const { aggregates } = c.req.valid('json');
          // Ownership (WS-E.1.3a): every aggregate must belong to the session
          // user; a batch attributing attention to anyone else is rejected.
          if (!aggregates.every((a) => aggregateBelongsToSession(a, auth.userId))) {
            return c.json(
              { error: { code: 'forbidden', message: 'Aggregate owner does not match session' } },
              403,
            );
          }
          const result = await ingestAttentionEvents(
            events,
            identity,
            auth.userId,
            aggregates.map((aggregate) => aggregateToCanonicalEvent(aggregate, auth.userId)),
            OFFLINE_SYNC_ACCEPTANCE,
          );
          // Hints, never ground truth (§25.5): the ack reports how many were
          // actually accepted after every guard.
          const ack: AttentionIngestAck = attentionIngestAckSchema.parse({
            accepted: result.accepted,
          });
          return c.json(ack, 202);
        },
      )

      // --- Telemetry / RUM ingest (WS-C observability; CSRF-exempt beacon) ---
      // CSRF-exempt + unauthenticated (sendBeacon), so it carries its own DoS
      // bounds like the CSP-report endpoint: a GLOBAL fixed-window rate limit
      // (§19.1 forbids per-IP state — this budget is identity-free) and a small
      // body cap, in addition to the ≤100-event schema bound.
      .post(
        '/telemetry',
        rateLimit({ limit: 120, windowMs: 60_000 }),
        bodyLimit({
          maxSize: 64 * 1024,
          onError: (c) => c.json({ error: 'Payload too large' }, 413),
        }),
        zValidator('json', telemetryBatchSchema),
        async (c) => {
          const { events } = c.req.valid('json');
          // Privacy-safe by schema (no URLs/PII, ≤100 events). The WS-P.1.1d
          // sink consumes the batch: web_vital events land in the sample store
          // for the rolling-p75 aggregation; every other event name counts into
          // the observability metrics. Ingest is BEST-EFFORT — a beacon cannot
          // retry, so a store outage drops the batch (counted) rather than 500s.
          let accepted = 0;
          try {
            accepted = await getTelemetryServices().ingest(events);
          } catch {
            getTelemetryServices().metrics.increment('telemetry.ingest.failed');
          }
          const ack: TelemetryIngestAck = telemetryIngestAckSchema.parse({ accepted });
          return c.json(ack, { status: 202 });
        },
      )

      // --- Push (WS-C.2.4a) -------------------------------------------------
      .get('/push/vapid-public-key', (c) => {
        const config = getVapidConfig();
        if (!config) {
          return c.json(
            { error: { code: 'push_unconfigured', message: 'Push is not configured' } },
            503,
          );
        }
        return c.json(vapidPublicKeyResponseSchema.parse({ publicKey: config.publicKey }));
      })
      .post('/push/subscriptions', zValidator('json', pushRegisterRequestSchema), async (c) => {
        // Push delivery is user-scoped (WS-D.1.4d security alerts, replies): an
        // endpoint with no authenticated owner is never delivered to, so we
        // require a session and scope BOTH register and remove to the user id.
        // Using the shared 'anonymous' key here would let any signed-in user
        // unsubscribe any endpoint they can name (the old cross-user bleed).
        const userId = await resolveOptionalUserId(c.req.header('cookie'));
        if (userId === null) {
          return c.json(
            { error: { code: 'unauthenticated', message: 'Authentication required' } },
            401,
          );
        }
        const { subscription } = c.req.valid('json');
        await registerSubscription(subscription, userId, userId);
        return c.json(okAckSchema.parse({ ok: true }), 201);
      })
      .delete(
        '/push/subscriptions',
        zValidator('json', z.object({ endpoint: z.string().url() })),
        async (c) => {
          // Scoped to the requesting USER — a user cannot unsubscribe another
          // user's endpoint (authorization, not just existence).
          const userId = await resolveOptionalUserId(c.req.header('cookie'));
          if (userId === null) {
            return c.json(
              { error: { code: 'unauthenticated', message: 'Authentication required' } },
              401,
            );
          }
          const removed = await removeSubscription(c.req.valid('json').endpoint, userId);
          return c.json(okAckSchema.parse({ ok: removed }));
        },
      )

      // --- Notification preferences (WS-C.2.4c) -----------------------------
      // Keyed like settings sync: USER id when signed in (survives re-login,
      // purged on account deletion), else the session id; a cookieless visitor
      // is never persisted server-side (no shared 'anonymous' key).
      .get('/notifications/preferences', async (c) => {
        const key = await settingsKey(c.req.header('cookie'));
        if (key === undefined) return c.json(DEFAULT_NOTIFICATION_PREFERENCES);
        return c.json(await getPreferences(key));
      })
      .patch(
        '/notifications/preferences',
        zValidator('json', notificationPreferencesSchema.partial()),
        async (c) => {
          const key = await settingsKey(c.req.header('cookie'));
          const merged = notificationPreferencesSchema.parse({
            ...(key === undefined ? DEFAULT_NOTIFICATION_PREFERENCES : await getPreferences(key)),
            ...c.req.valid('json'),
          });
          if (key !== undefined) await setPreferences(key, merged);
          return c.json(merged);
        },
      )
      .get('/notifications', authMiddleware(), async (c) => {
        const auth = getAuth(c);
        if (!auth) return c.json(notFound, 404);
        const notifications = await replyNotifications.listForUser(auth.userId);
        return c.json(
          notificationsResponseSchema.parse({
            notifications,
            unread_count: await replyNotifications.unreadCount(auth.userId),
          }),
        );
      })
      .post(
        '/notifications/:notificationId/read',
        authMiddleware(),
        zValidator('param', z.object({ notificationId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(notFound, 404);
          const { notificationId } = c.req.valid('param');
          if (!(await replyNotifications.markRead(notificationId, auth.userId)))
            return c.json(notFound, 404);
          return c.json(okAckSchema.parse({ ok: true }));
        },
      )
  );
}

export type V1Routes = ReturnType<typeof createV1Routes>;

/** Test helper: clear the bound settings store between cases. */
export function resetSettingsState(): void {
  void getUserSettingsStore().clear();
}
