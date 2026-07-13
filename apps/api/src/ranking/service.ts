// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I feed service — the eight SPEC §13.3 stages composed end to end:
//
//   candidate generation (orchestrator) → feature join (feature store +
//   per-request relevance) → safety filter → constrained scoring →
//   diversification → decision logging → card signals → feed response
//
// Serving and replay (WS-I.2.5b) execute the SAME pure core
// (`rankFeasibleSet` from @licio/ranking) over the same pinned inputs: the
// decision log records the feature revision per feasible item, the exact
// profile snapshot, the promotion-enforcement flags, the resolved per-item
// relevance, and the per-item lens assignments — so any decision is
// reproducible at its recorded versions, byte for byte.
//
// EXACTLY ONE decision log per served request (ranked, fallback — every
// pipeline path). A failed log write never fails the feed (availability),
// but it is loudly logged and counted: a missing log is an auditability
// incident (WS-I.2.5a observability).
//
// Surfaces: `front_page` (GET /v1/feed), `topic` (GET /v1/feed?topic=…,
// pool scoped to the topic, sensitivity derived from it), and `room`
// (GET /v1/rooms/:roomId/feed, pool scoped to the room; ACCESS to
// restricted rooms is enforced by the route via `roomContentVisibleToUser`
// BEFORE this service runs). Room feeds carry real lens assignments
// (derived from lens-tagged contributions) into WS-I.2.4b lens balancing.

import { randomUUID } from 'node:crypto';
import {
  type Candidate,
  candidateSchema,
  chronologicalOrder,
  diffRankings,
  emptyFeatureVector,
  type FallbackReason,
  FEATURE_SCHEMA_VERSION,
  type FeatureVector,
  gweiDeploymentGate,
  metricOrder,
  type RankingDecisionLog,
  type RankingProfileConfig,
  type RankingRequestContext,
  type ReplayDiffEntry,
  rankFeasibleSet,
  rankingDecisionLogSchema,
  retentionDeadline,
  type SafetyExclusion,
  type ScoredItem,
  selectProfileForContext,
  topicRelevance,
  type UserOrdering,
} from '@licio/ranking';
import {
  deriveStorySafetyState,
  type FeedItem,
  type FeedMode,
  type FeedModeCompat,
  feedItemSchema,
  isSentinelTopicId,
  LEGACY_DISTRIBUTION_REASON,
  legacyRatingLabel,
  normalizeFeedMode,
  rankingDecisionLoggedEventSchema,
  TOPIC_ID_BY_SLUG,
  TOPIC_REGISTRY,
  uuidSchema,
} from '@licio/shared';
import type { NewStoredEvent } from '../events/stores.js';
import {
  EMPTY_CARD_SIGNALS,
  type StoryCardSignals,
  storyCardSignals,
} from '../forum/card-signals.js';
import { roomContentVisibleToUser } from '../forum/rooms.js';
import type { ThreadShellRecord } from '../ingestion/stores.js';
import { makeMediaUrlMinter } from '../lib/media-urls.js';
import { feedMediaOf } from '../lib/story-media.js';
import { killSwitchDecision } from './killswitch.js';
import { assembleCandidatePool } from './orchestrator.js';
import { applySafetyFilter } from './safety-filter.js';
import { type RankingServices, refreshStoryFeatures } from './services.js';

export interface FeedServeRequest {
  userId: string | null;
  surface: 'front_page' | 'room' | 'topic';
  surfaceRoomId: string | null;
  /** The topic a `topic`-surface request is scoped to (`?topic=`). */
  surfaceTopicId: string | null;
  /** Wire value, canonical or legacy (pre-redesign cached bundles still send
   *  legacy modes) — normalized via `normalizeFeedMode` before serving (see
   *  LEGACY_FEED_MODES in @licio/shared). */
  mode: FeedModeCompat | undefined;
  /** SEEN-AWARE pagination cursor: the previous page's request id. The next
   *  page re-runs the pipeline excluding everything that page chain already
   *  served. Absent/unknown/expired cursors serve the first page (clients
   *  recover gracefully — a swept chain is not an error). */
  cursor?: string | null;
}

export interface ServedFeed {
  requestId: string;
  items: FeedItem[];
  fallback: boolean;
  /** Cursor for the NEXT page (this request's id) when unserved feasible
   *  items remain; null when the feed is exhausted. */
  nextCursor: string | null;
}

/** Bounded pagination-chain walk (≈ caps a session at 20 ranked pages). */
const PAGINATION_CHAIN_CAP = 20;

/**
 * Resolve a pagination cursor to the EXCLUSION set: the union of selected
 * ids along the page chain (each log links its parent). Unknown cursors —
 * garbage, or a chain head swept by §22.4 retention — resolve to an empty
 * set and a null parent: the request serves the first page, never an
 * error. Cursors are opaque request ids; resolving one reveals no content
 * (it only REMOVES items from the requester's own next page).
 */
async function resolveCursorExclusions(
  services: RankingServices,
  cursor: string | null | undefined,
): Promise<{ excluded: Set<string>; parentRequestId: string | null }> {
  const excluded = new Set<string>();
  if (cursor === null || cursor === undefined || !uuidSchema.safeParse(cursor).success) {
    return { excluded, parentRequestId: null };
  }
  let parentRequestId: string | null = null;
  let current: string | null = cursor;
  for (let hop = 0; hop < PAGINATION_CHAIN_CAP && current !== null; hop += 1) {
    const log: RankingDecisionLog | null = await services.decisionLogs.getByRequestId(current);
    if (log === null) break; // swept or unknown: exclude what still resolves
    if (hop === 0) parentRequestId = log.request_id;
    for (const itemId of log.selected_ids) excluded.add(itemId);
    current = log.parent_request_id;
  }
  return { excluded, parentRequestId };
}

/** Request freshness class from the pool's median age (deterministic). */
function poolFreshnessClass(
  pool: readonly Candidate[],
  nowMs: number,
): 'breaking' | 'recent' | 'evergreen' {
  if (pool.length === 0) return 'evergreen';
  const ages = pool
    .map((c) => Math.max(0, nowMs - Date.parse(c.freshness_timestamp)))
    .sort((a, b) => a - b);
  const median = ages[Math.floor(ages.length / 2)] ?? 0;
  const hours = median / 3_600_000;
  if (hours < 6) return 'breaking';
  if (hours < 72) return 'recent';
  return 'evergreen';
}

/** Story safety posture for the wire (descriptive, never a sanction). Thin
 *  adapter over the shared `deriveStorySafetyState` so the feed and the
 *  story-detail read derive the posture identically. */
function feedSafetyState(
  features: FeatureVector | undefined,
  thread: ThreadShellRecord | undefined,
  frozen: boolean,
): FeedItem['safety_state'] {
  return deriveStorySafetyState({
    frozen,
    mfciRiskState: features?.mfci_risk_state,
    threadSafetyState: thread?.safetyState,
  });
}

/**
 * Batch the SPEC §5.6 story-card signals for a feed page — the shared forum
 * derivation over this page's story→thread map.  Both the ranked path and the
 * WS-I.4.1b fallback serve through this, so a degraded feed still carries
 * honest signals.
 */
async function cardSignalsForPage(
  services: RankingServices,
  storyIds: readonly string[],
): Promise<Map<string, StoryCardSignals>> {
  if (storyIds.length === 0) return new Map();
  const threads = await services.ingestion.stories.getThreadsByStoryIds([...storyIds]);
  const threadByStory = new Map<string, string | null>();
  for (const storyId of storyIds) {
    threadByStory.set(storyId, threads.get(storyId)?.threadId ?? null);
  }
  return storyCardSignals(services.forum, services.events.safetyStore, threadByStory);
}

/** One selected entry on its way to the wire. */
interface SelectedEntry {
  itemId: string;
  score: number;
  features: FeatureVector | undefined;
  /** Same-cluster items demoted by dedup ("more on this story"). */
  moreOnThisStory: readonly string[];
  /** The batched §5.6 card signals (sourced comments + corrections tally). */
  signals: StoryCardSignals;
}

/**
 * Map selected entries onto §23.3 FeedItems with BATCHED reads: one bulk
 * story read, one bulk thread read, one bulk safety read — never per-item
 * serial round trips on the serving path.  The §5.6 card signals (sourced
 * comments + corrections tally) arrive pre-batched on each entry.
 */
async function buildFeedItems(
  services: RankingServices,
  entries: readonly SelectedEntry[],
): Promise<FeedItem[]> {
  if (entries.length === 0) return [];
  const ids = entries.map((entry) => entry.itemId);
  const [stories, threads, safeties] = await Promise.all([
    services.ingestion.stories.getByIds(ids),
    services.ingestion.stories.getThreadsByStoryIds(ids),
    services.events.safetyStore.getMany(ids),
  ]);
  const items: FeedItem[] = [];
  for (const entry of entries) {
    const story = stories.get(entry.itemId);
    if (story === undefined) continue;
    const thread = threads.get(entry.itemId);
    const excerptWords = story.excerpt === null ? 0 : story.excerpt.split(/\s+/).length;
    const chips: Array<{ id: string; label: string }> = [];
    if (entry.features?.mfci_risk_state === 'normal') {
      chips.push({ id: 'coordination', label: 'low coordination risk' });
    }
    if (entry.moreOnThisStory.length > 0) {
      chips.push({
        id: 'more-on-this-story',
        label: `+${entry.moreOnThisStory.length} more on this story`,
      });
    }
    const safetyState = feedSafetyState(
      entry.features,
      thread,
      safeties.get(entry.itemId)?.safetyState === 'frozen',
    );
    items.push(
      feedItemSchema.parse({
        story_id: story.storyId,
        title: story.title,
        source: story.publisher ?? story.canonicalUrl ?? 'Community submission',
        ...(story.canonicalUrl !== null ? { url: story.canonicalUrl } : {}),
        visibility: story.visibility,
        media: feedMediaOf(story, makeMediaUrlMinter()),
        reading_minutes: Math.max(1, Math.ceil(excerptWords / 200)),
        // SPEC §5.6 — the compact card signals that replaced the rating label:
        // the sourced-comment count (matches the comment section's "Sources"
        // view) and the WS-T corrections tally for the comment section.
        sources_count: entry.signals.sourced,
        corrections: entry.signals.corrections,
        // DEPRECATED rollout compat: pre-redesign cached bundles REQUIRE
        // rating_label; emit the legacy approximation until they age out
        // (see LEGACY_RATING_LABELS in @licio/shared).
        rating_label: legacyRatingLabel({
          lifecycleState: story.lifecycleState,
          safetyState,
          ...(entry.features?.active_attention !== undefined
            ? { activeAttention: entry.features.active_attention }
            : {}),
        }),
        // DEPRECATED rollout compat: the per-card distribution reason was
        // removed; pre-removal cached bundles REQUIRE a non-empty string
        // (see LEGACY_DISTRIBUTION_REASON in @licio/shared).
        distribution_reason: LEGACY_DISTRIBUTION_REASON,
        context_chips: chips,
        safety_state: safetyState,
        more_on_this_story: [...entry.moreOnThisStory].slice(0, 12),
        // Never surface the UNCLASSIFIED sentinel as a topic on the wire — it
        // would drive a topic-repeats control for a non-subject "topic".
        topic_ids: story.topicIds.filter((id) => !isSentinelTopicId(id)).slice(0, 8),
        // WS-T dispute posture: `incorrect` stories are already sunk to the
        // bottom by the WS-I ordering sink; surfacing the status lets the card
        // label them "Challenged"/"Incorrect".
        dispute_status: story.disputeStatus ?? 'none',
      }),
    );
  }
  return items;
}

interface DecisionLogDraft {
  log: RankingDecisionLog;
}

/**
 * Insert the decision log + emit the per-item events; never throws. Returns
 * whether the LOG insert landed: pagination must not advertise a cursor
 * whose chain link does not exist (the next page would re-serve page one).
 */
async function commitDecision(
  services: RankingServices,
  draft: DecisionLogDraft,
  selected: ReadonlyArray<{ itemId: string; score: number }>,
  surface: 'front_page' | 'room' | 'topic',
): Promise<boolean> {
  try {
    await services.decisionLogs.insert(draft.log);
  } catch (error) {
    // A missing decision log is an AUDITABILITY INCIDENT — loud, counted,
    // but never a serving failure (WS-I.2.5a).
    services.events.metrics.increment('ranking.decision_log.write_failed');
    services.log('ranking.decision.log_failed', {
      request_id: draft.log.request_id,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
  services.log('ranking.decision.logged', {
    request_id: draft.log.request_id,
    candidates: draft.log.candidate_ids.length,
    selected: draft.log.selected_ids.length,
    fallback: draft.log.fallback,
  });
  // §21.3 topic: one `ranking.decision.logged` event per SELECTED item —
  // built as ONE batch, persisted with ONE insertMany (never one INSERT per
  // item on the serving path), then published in-process.
  const registry = TOPIC_REGISTRY['ranking.decision.logged'];
  const context = surface === 'room' ? ('room' as const) : ('feed' as const);
  const events = selected.map((entry, position) =>
    rankingDecisionLoggedEventSchema.parse({
      event_id: randomUUID(),
      event_type: 'ranking.decision.logged',
      timestamp: draft.log.timestamp,
      schema_version: '1',
      decision_id: draft.log.request_id,
      story_id: entry.itemId,
      context,
      score: entry.score,
      position,
      signals_used: signalNamesOf(draft.log, entry.itemId),
      privacy_classification: 'sensitive',
      retention_tier: 'ranking_log',
    }),
  );
  if (events.length > 0) {
    const rows: NewStoredEvent[] = events.map((event) => ({
      eventId: event.event_id,
      eventType: event.event_type,
      topic: event.event_type,
      timestamp: event.timestamp,
      privacyClassification: registry.privacy_classification,
      retentionTier: registry.retention_tier,
      payload: event as unknown as Record<string, unknown>,
      ownerUserId: null,
      purgeAfter: null,
    }));
    try {
      await services.events.eventStore.insertMany(rows);
      for (const event of events) {
        services.trackBackground(services.events.router.publish(event));
      }
    } catch (error) {
      // The §21.3 per-item events are AUDIT artifacts, exactly like the
      // decision log above: a transient event-store outage is a counted
      // incident, never a serving failure — the user still gets the feed.
      services.events.metrics.increment('ranking.decision_event.write_failed');
      services.log('ranking.decision.event_failed', {
        request_id: draft.log.request_id,
        events: rows.length,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  return true;
}

/** Signal NAMES that fed one item's decision (names only, never values). */
function signalNamesOf(log: RankingDecisionLog, itemId: string): string[] {
  const scored = log.score_components[itemId];
  if (scored === undefined) {
    // Fallback / user-ordered serves carry no score components; the audit
    // names the ONE ordering signal that ran (`new` IS the chronological
    // ordering, degradations always serve chronological).
    switch (log.user_ordering) {
      case 'rising':
        return ['attention_velocity'];
      case 'sources':
        return ['sources_count'];
      case 'debates':
        return ['corrections_tally'];
      default:
        return ['chronological'];
    }
  }
  const names: string[] = [];
  const components = scored.score_components;
  if (components.active_attention !== null) names.push('active_attention');
  if (components.constructive_participation !== null) names.push('constructive_participation');
  if (components.exposure_independence !== null) names.push('exposure_independence');
  if (components.source_evidence_completeness !== null) {
    names.push('source_evidence_completeness');
  }
  if (components.context_coherence_gain !== null) names.push('context_coherence_gain');
  names.push('freshness', 'source_reliability');
  if (scored.baseline.topic_relevance !== null) names.push('topic_relevance');
  for (const [name, term] of Object.entries(scored.penalty_components)) {
    if (typeof term === 'object' && term !== null && 'applied' in term && term.applied > 0) {
      names.push(`penalty_${name}`);
    }
  }
  // WS-T — the validation boost is an ADDED term (challenged + proven accurate);
  // surface it as a used signal so the audit reflects the actual score arithmetic.
  if (scored.validation_boost.applied > 0) names.push('validation_boost');
  return names.slice(0, 50);
}

/**
 * Real lens assignments for room-surface lens balancing (WS-I.2.4b): each
 * feasible item's lens is the MOST FREQUENT `lens_id` among its thread's
 * lens-tagged contributions (ties → lexicographically smallest, so the
 * assignment is deterministic and replayable). Items with no lens-tagged
 * contributions carry no lens.
 */
async function lensAssignments(
  services: RankingServices,
  feasible: readonly Candidate[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const threads = await services.ingestion.stories.getThreadsByStoryIds(
    feasible.map((c) => c.item_id),
  );
  const threadToStory = new Map<string, string>();
  for (const [storyId, thread] of threads) threadToStory.set(thread.threadId, storyId);
  if (threadToStory.size === 0) return out;
  const tagged = await services.forum.contributions.listLensTagged([...threadToStory.keys()], 500);
  const countsByStory = new Map<string, Map<string, number>>();
  for (const contribution of tagged) {
    const storyId = threadToStory.get(contribution.threadId);
    const lensId = (contribution.metadata as { lens_id?: unknown }).lens_id;
    if (storyId === undefined || typeof lensId !== 'string') continue;
    const counts = countsByStory.get(storyId) ?? new Map<string, number>();
    counts.set(lensId, (counts.get(lensId) ?? 0) + 1);
    countsByStory.set(storyId, counts);
  }
  for (const [storyId, counts] of countsByStory) {
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best !== undefined) out.set(storyId, best[0]);
  }
  return out;
}

/**
 * WS-Q.4.2a — the surface-aware DISTRIBUTION gate (§14.5.3/§16.2), the
 * authoritative ALWAYS-ON containment backstop. Evaluated once per DISTINCT
 * room in the pool (bounded by pool diversity, never per item); an unknown room
 * fails closed (every item now has a room — there is no room-less pass-through).
 *
 *   • front_page / topic: the SAME two-condition global test the retrievers and
 *     search use — drop a candidate unless `item.visibility = 'public'` AND its
 *     room is public. A room_only item, OR a transiently-mislabeled public item
 *     in a private room, is dropped even if a buggy retriever emitted it.
 *   • room: keep this room's full pool behind the content bar; a FOREIGN-room
 *     room_only item is dropped (own-room room_only passes).
 *
 * Each drop is reason-coded (`item_visibility` / `room_private_on_global` /
 * `room_bar`); the excluded count rides the decision log (WS-Q.4.2b).
 */
async function filterByVisibility(
  services: RankingServices,
  pool: readonly Candidate[],
  userId: string | null,
  requestId: string,
  surface: 'front_page' | 'room' | 'topic',
  surfaceRoomId: string | null,
): Promise<{ filtered: Candidate[]; excludedCount: number }> {
  const roomIds = [
    ...new Set(pool.map((c) => c.room_id).filter((id): id is string => id !== null)),
  ];
  const roomPublic = new Map<string, boolean>();
  const roomReadable = new Map<string, boolean>();
  for (const roomId of roomIds) {
    const room = await services.forum.rooms.getById(roomId);
    if (room === null) continue; // unknown room ⇒ fail closed (absent ⇒ false)
    roomPublic.set(roomId, room.visibility === 'public');
    roomReadable.set(roomId, await roomContentVisibleToUser(services.forum, room, userId));
  }
  const reasons = new Map<string, number>();
  const drop = (reason: string): false => {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    return false;
  };
  const onGlobal = surface !== 'room';
  const filtered = pool.filter((c) => {
    const roomId = c.room_id;
    if (roomId === null) return drop('missing_room'); // fail closed
    if (onGlobal) {
      // Two-condition global containment: public item from a public room.
      if (c.visibility !== 'public') return drop('item_visibility');
      if (roomPublic.get(roomId) !== true) return drop('room_private_on_global');
      return true;
    }
    // Room surface: the room content bar, then drop FOREIGN-room room_only.
    if (roomReadable.get(roomId) !== true) return drop('room_bar');
    if (c.visibility === 'room_only' && roomId !== surfaceRoomId) return drop('item_visibility');
    return true;
  });
  const excludedCount = pool.length - filtered.length;
  if (excludedCount > 0) {
    services.log('ranking.visibility.filtered', {
      request_id: requestId,
      surface,
      excluded_count: excludedCount,
      reasons: Object.fromEntries(reasons),
    });
  }
  return { filtered, excludedCount };
}

/**
 * Stage-2 feature join, shared by the ranked path and the `rising` user
 * ordering so both operate on CURRENT-schema vectors. Bulk-reads the latest
 * vectors, then per item:
 *
 *  • Cold-start write-through (WS-I.2.5b): an item the feature store has not
 *    covered yet joins the honest EMPTY vector — which must itself be a
 *    stored revision, or the decision could not be replayed at its recorded
 *    versions. The empty vector carries metadata only.
 *  • Migration-on-read: a STALE-schema row (a store carried across a
 *    FEATURE_SCHEMA_VERSION bump) can hold the old field set (e.g. no
 *    `attention_velocity`), so scoring/ordering would run on old fields
 *    while the decision log claims the new version. Rebuild it at the
 *    current schema first; the rebuilt row sticks (one-time, self-healing).
 */
async function currentFeaturesFor(
  services: RankingServices,
  candidates: readonly Candidate[],
  nowMs: number,
): Promise<Map<string, FeatureVector>> {
  const featuresById = await services.featureStore.getLatestMany(candidates.map((c) => c.item_id));
  for (const candidate of candidates) {
    const stored = featuresById.get(candidate.item_id);
    if (stored !== undefined && stored.feature_version >= FEATURE_SCHEMA_VERSION) continue;
    if (stored !== undefined) {
      await refreshStoryFeatures(services, candidate.item_id);
      const rebuilt = await services.featureStore.getLatest(candidate.item_id);
      featuresById.set(
        candidate.item_id,
        rebuilt !== null && rebuilt.feature_version >= FEATURE_SCHEMA_VERSION
          ? rebuilt
          : emptyFeatureVector(candidate, nowMs),
      );
      continue;
    }
    const empty = emptyFeatureVector(candidate, nowMs);
    const written = await services.featureStore.upsert(empty);
    if (written !== null) {
      featuresById.set(candidate.item_id, written);
    } else {
      // Lost a race to a concurrent writer: use whatever landed.
      const latest = await services.featureStore.getLatest(candidate.item_id);
      if (latest !== null) featuresById.set(candidate.item_id, latest);
    }
  }
  return featuresById;
}

/** Serve one feed request through the full WS-I pipeline. */
export async function serveFeed(
  services: RankingServices,
  request: FeedServeRequest,
): Promise<ServedFeed> {
  const requestId = randomUUID();
  const nowMs = services.now();
  const nowIso = new Date(nowMs).toISOString();
  const config = services.config();
  const bucket = services.privacyBucket(request.userId);
  const user = await services.userContext(request.userId);
  // Request > stored default > platform default. Either source can be a
  // legacy value (pre-redesign bundles still send them; pre-redesign blobs
  // round-trip unchanged) — `normalizeFeedMode` is total over strings, and
  // the mapping preserves intent by construction (legacy
  // `low-personalization` lands on the non-personalized `new` sort, so no
  // raw-value special case is needed here).
  const mode: FeedMode = normalizeFeedMode(request.mode ?? user.feedModeDefault ?? 'best');

  // --- Stage 1: candidate generation --------------------------------------
  const retrievalBudget = Math.max(...config.profiles.map((p) => p.candidate_budget));
  const baseProfile =
    config.profiles.find((p) => p.profile_id === 'evergreen') ?? config.profiles[0];
  if (baseProfile === undefined) throw new Error('no ranking profiles configured');
  const assembled = await assembleCandidatePool(
    services.retrievers,
    services.classification,
    { ...baseProfile, candidate_budget: retrievalBudget },
    {
      userId: request.userId,
      surface: request.surface,
      surfaceRoomId: request.surfaceRoomId,
      nowMs,
      limit: Math.max(20, Math.floor(retrievalBudget / 4)),
    },
    services.log,
    bucket,
  );

  // Surface scoping: a room feed ranks the ROOM's items; a topic feed ranks
  // the TOPIC's items (room ACCESS was enforced by the route before this).
  let surfacePool = assembled.pool;
  if (request.surface === 'room' && request.surfaceRoomId !== null) {
    surfacePool = surfacePool.filter((c) => c.room_id === request.surfaceRoomId);
  } else if (request.surface === 'topic' && request.surfaceTopicId !== null) {
    // `?topic=` may be a catalog SLUG (the canonical public form) or a raw
    // catalog UUID; resolve a known slug to its UUID so it matches candidates'
    // trusted catalog topic ids (UUIDs). An unknown value passes through
    // unchanged (already a UUID, or a test/legacy slug the seed used directly).
    const topicId = TOPIC_ID_BY_SLUG.get(request.surfaceTopicId) ?? request.surfaceTopicId;
    surfacePool = surfacePool.filter((c) => c.topic_ids.includes(topicId));
  }
  // WS-Q.4.2a — the always-on distribution gate runs BEFORE the ranked/fallback
  // split, so both paths inherit identical containment (WS-Q.4.2b).
  const visibilityGate = await filterByVisibility(
    services,
    surfacePool,
    request.userId,
    requestId,
    request.surface,
    request.surfaceRoomId,
  );
  surfacePool = visibilityGate.filtered;
  const visibilityExcludedCount = visibilityGate.excludedCount;

  // WS-J.1.2 — bilateral block + one-directional mute hide content FROM THE
  // VIEWER on the distribution side (the per-viewer complement to the global,
  // item-level safety filter).  Wired via the forum relationship-reader seam;
  // null reader (forum standalone) is a no-op.
  if (
    request.userId !== null &&
    services.forum.relationshipReader !== null &&
    surfacePool.length > 0
  ) {
    const sets = await services.forum.relationshipReader.setsFor(request.userId);
    const hide = new Set<string>(sets.blocked);
    for (const id of sets.muted) hide.add(id);
    if (hide.size > 0) {
      const stories = await services.ingestion.stories.getByIds(surfacePool.map((c) => c.item_id));
      const before = surfacePool.length;
      surfacePool = surfacePool.filter((c) => {
        const author = stories.get(c.item_id)?.submittedBy ?? null;
        return author === null || !hide.has(author);
      });
      if (before !== surfacePool.length) {
        services.log('ranking.relationship_filter.applied', {
          request_id: requestId,
          excluded_count: before - surfacePool.length,
        });
      }
    }
  }

  // Seen-aware pagination: items the cursor's page chain already served
  // leave the pool BEFORE profile selection and the safety filter, so the
  // next page is a fresh, fully-pipelined ranking over the remainder.
  const { excluded: pageExcluded, parentRequestId } = await resolveCursorExclusions(
    services,
    request.cursor,
  );
  if (pageExcluded.size > 0) {
    surfacePool = surfacePool.filter((c) => !pageExcluded.has(c.item_id));
  }

  // Profile selection context: the topic surface derives its sensitivity
  // from the requested topic; jurisdiction stays the WS-N seam (null) and
  // request-level risk the WS-J seam ('normal') — item-level risk is
  // enforced per item by the constraint stage regardless.
  const topicSensitivity =
    request.surface === 'topic' &&
    request.surfaceTopicId !== null &&
    services.sensitiveTopicIds().has(request.surfaceTopicId)
      ? ('sensitive' as const)
      : ('standard' as const);
  const profileContext = {
    surface: request.surface,
    freshness: poolFreshnessClass(surfacePool, nowMs),
    topicSensitivity,
    ageGroup: (user.ageBand ?? 'unknown') as 'adult' | 'teen_16_17' | 'teen_13_15' | 'unknown',
    jurisdiction: null,
    riskState: 'normal' as const,
  };
  const profile = selectProfileForContext(profileContext, config.profiles) ?? baseProfile;
  services.log('ranking.profile.selected', {
    request_id: requestId,
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    surface: request.surface,
  });

  // --- Stage 3: safety filter (before scoring; authoritative) -------------
  const safety = await applySafetyFilter(surfacePool, services.moderation, {
    ageBand: user.ageBand,
    jurisdiction: null,
  });
  if (safety.exclusions.length > 0) {
    services.log('ranking.safety_filter.applied', {
      request_id: requestId,
      excluded_count: safety.exclusions.length,
      exclusions: safety.exclusions.map((e) => ({
        item_id: e.item_id,
        policy_reason: e.policy_reason,
      })),
    });
  }

  // --- Serving-mode decision: kill switch / user mode / GWEI gate ---------
  const killSwitch = await killSwitchDecision(services.events, request.surface, profile.profile_id);
  const enforcement = await services.enforcement();
  const gwei = gweiDeploymentGate(await services.latestGweiDisparity(), profile, enforcement);
  // The documented-owner override (SPEC §9.5): a tripped gate keeps ranked
  // serving while the override is live, logged LOUDLY with the owner on
  // every affected request — never silent.
  const override = config.gweiOverride;
  const gweiOverridden =
    gwei.blocked && override !== null && override.untilMs > nowMs ? override : null;
  if (gweiOverridden !== null) {
    services.events.metrics.increment('ranking.gwei_gate.overridden');
    services.log('ranking.gwei_gate.overridden', {
      request_id: requestId,
      owner: gweiOverridden.owner,
      reason: gweiOverridden.reason,
      until: new Date(gweiOverridden.untilMs).toISOString(),
    });
  }
  // The kill switch outranks EVERYTHING (an engaged switch serves plain
  // chronological even for an explicit sort request — the operator pulled the
  // plug on computed orderings); then the user's explicit sort order (`best`
  // is the ranked pipeline, every other mode is a complete deterministic
  // ordering over the same safety-filtered set); the GWEI gate binds only the
  // ranked objective it measures.
  let fallbackReason: FallbackReason | null = null;
  let userOrdering: UserOrdering | null = null;
  if (killSwitch.engaged) {
    fallbackReason = 'kill_switch';
  } else if (mode !== 'best') {
    fallbackReason = 'user_mode';
    userOrdering = mode;
  } else if (gwei.blocked && gweiOverridden === null) {
    fallbackReason = 'gwei_gate';
  } else if (safety.feasible.length === 0) {
    fallbackReason = 'empty_pool';
  }

  if (fallbackReason !== null) {
    return serveFallback(services, request, {
      requestId,
      parentRequestId,
      nowIso,
      nowMs,
      bucket,
      profile,
      feasible: safety.feasible,
      candidateIds: surfacePool.map((c) => c.item_id),
      safetyExclusions: safety.exclusions,
      quotaOutcomes: assembled.quotaOutcomes,
      reason: fallbackReason,
      userOrdering,
      gweiApplication: gwei.application,
      retentionDays: config.decisionLogRetentionDays,
      visibilityExcludedCount,
    });
  }

  // --- Stage 2 (join) + 4–5 (score + diversify) ----------------------------
  const featuresById = await currentFeaturesFor(services, safety.feasible, nowMs);
  // Only `best` reaches this ranked path (every other mode fell back to its
  // complete deterministic ordering above, and legacy `low-personalization`
  // normalizes to `new`), so the user's durable privacy setting is the sole
  // personalization switch.
  const personalizationOn = user.personalizationEnabled;
  let relevanceByItem: Map<string, number> | null = null;
  if (personalizationOn && request.userId !== null) {
    relevanceByItem = new Map();
    for (const candidate of safety.feasible) {
      const topics = featuresById.get(candidate.item_id)?.topic_ids ?? candidate.topic_ids;
      relevanceByItem.set(candidate.item_id, topicRelevance(topics, user.topicPreferences));
    }
  }
  const phiRisk = request.userId === null ? null : await services.userPhiRisk(request.userId);
  // No serving path sets a balancing override any more (the `source-diverse`
  // mode was replaced by the explicit sort orders); the context field and the
  // replay-inputs slot remain so pre-redesign decision logs replay exactly.
  const sourceShareOverride: number | null = null;
  // Real lens assignments for room-surface lens balancing (WS-I.2.4b).
  const lensByItem =
    request.surface === 'room' && request.surfaceRoomId !== null
      ? await lensAssignments(services, safety.feasible)
      : null;
  const context: RankingRequestContext = {
    surface: request.surface,
    surfaceRoomId: request.surfaceRoomId,
    nowMs,
    topicRelevanceByItem: relevanceByItem,
    userPhiRisk: phiRisk,
    sensitiveTopicIds: services.sensitiveTopicIds(),
    maxSourceSharePctOverride: sourceShareOverride,
    lensByItem,
  };
  const ranked = rankFeasibleSet(safety.feasible, featuresById, profile, enforcement, context);

  // Feasibility invariant (WS-I.2.2a): nothing outside the safety-filtered
  // set can be served — asserted, not assumed.
  const feasibleIds = new Set(safety.feasible.map((c) => c.item_id));
  for (const item of ranked.selected) {
    if (!feasibleIds.has(item.item_id)) {
      throw new Error(`ranking served an item outside the feasible set: ${item.item_id}`);
    }
  }
  if (gwei.application !== null) ranked.applications.push(gwei.application);

  // --- Stage 7: card signals + entry assembly -------------------------------
  const signalsByStory = await cardSignalsForPage(
    services,
    ranked.selected.map((scored) => scored.item_id),
  );
  // "More on this story" (WS-I.2.4a): the selected cluster representative
  // carries its demoted same-cluster siblings.
  const moreByItem = new Map<string, string[]>();
  for (const scored of ranked.selected) {
    const cluster = featuresById.get(scored.item_id)?.duplicate_cluster_id;
    if (cluster === undefined) continue;
    const expansion = ranked.expansions.get(cluster);
    if (expansion !== undefined && expansion.length > 0) {
      moreByItem.set(scored.item_id, expansion);
    }
  }
  const scoreComponents: Record<string, ScoredItem> = {};
  const entries: SelectedEntry[] = [];
  for (const scored of ranked.selected) {
    const features = featuresById.get(scored.item_id);
    scoreComponents[scored.item_id] = scored;
    entries.push({
      itemId: scored.item_id,
      score: scored.pwatt_score,
      features,
      moreOnThisStory: moreByItem.get(scored.item_id) ?? [],
      signals: signalsByStory.get(scored.item_id) ?? EMPTY_CARD_SIGNALS,
    });
  }
  const items = await buildFeedItems(services, entries);
  const servedIds = new Set(items.map((item) => item.story_id));
  const selectedForEvents = entries
    .filter((entry) => servedIds.has(entry.itemId))
    .map((entry) => ({ itemId: entry.itemId, score: entry.score }));

  // --- Stage 6: decision logging -------------------------------------------
  const featureRevisions: Record<string, number> = {};
  const invariantVersions: RankingDecisionLog['invariant_versions'] = {};
  for (const candidate of safety.feasible) {
    const features = featuresById.get(candidate.item_id);
    featureRevisions[candidate.item_id] = features?.revision ?? 0;
    for (const [name, entry] of Object.entries(features?.invariant_versions ?? {})) {
      invariantVersions[name] = entry;
    }
  }
  const log = rankingDecisionLogSchema.parse({
    request_id: requestId,
    parent_request_id: parentRequestId,
    surface: request.surface,
    user_privacy_bucket: bucket,
    candidate_ids: surfacePool.map((c) => c.item_id),
    selected_ids: selectedForEvents.map((s) => s.itemId),
    score_components: scoreComponents,
    feature_revisions: featureRevisions,
    invariant_versions: invariantVersions,
    constraints_applied: ranked.applications,
    safety_exclusions: safety.exclusions,
    visibility_excluded_count: visibilityExcludedCount,
    quota_outcomes: assembled.quotaOutcomes,
    experiment_ids: [],
    timestamp: nowIso,
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    feature_version: FEATURE_SCHEMA_VERSION,
    fallback: false,
    fallback_reason: null,
    replay_inputs: {
      profile_snapshot: profile,
      enforcement,
      topic_relevance: relevanceByItem === null ? null : Object.fromEntries(relevanceByItem),
      user_phi_risk: phiRisk,
      max_source_share_pct_override: sourceShareOverride,
      surface_room_id: request.surfaceRoomId,
      lens_by_item: lensByItem === null ? null : Object.fromEntries(lensByItem),
    },
    retain_until: retentionDeadline(nowIso, config.decisionLogRetentionDays),
  });
  const logCommitted = await commitDecision(services, { log }, selectedForEvents, request.surface);

  // Seen-aware pagination: more pages exist while UNSERVED feasible items
  // remain (an empty page never advertises a next page — no client loops),
  // and only when the chain link PERSISTED (a cursor pointing at a failed
  // log write would silently re-serve page one).
  const hasMore =
    logCommitted &&
    items.length > 0 &&
    safety.feasible.some((candidate) => !servedIds.has(candidate.item_id));
  return { requestId, items, fallback: false, nextCursor: hasMore ? requestId : null };
}

interface FallbackArgs {
  requestId: string;
  parentRequestId: string | null;
  nowIso: string;
  nowMs: number;
  bucket: string;
  profile: RankingProfileConfig;
  feasible: readonly Candidate[];
  candidateIds: readonly string[];
  safetyExclusions: readonly SafetyExclusion[];
  quotaOutcomes: RankingDecisionLog['quota_outcomes'];
  reason: FallbackReason;
  /** The user-selected sort order when `reason === 'user_mode'`; null on the
   *  degradation reasons (kill switch, GWEI gate, empty pool), which always
   *  serve plain chronological. */
  userOrdering: UserOrdering | null;
  gweiApplication: RankingDecisionLog['constraints_applied'][number] | null;
  retentionDays: number;
  /** WS-Q.4.2b — visibility-gate drops (the gate ran before the ranked/fallback
   *  split, so this count is identical on both paths). */
  visibilityExcludedCount: number;
}

/**
 * Resolve the served ordering over the SAFETY-FILTERED set:
 *
 *   • degradations + the `new` mode — strict chronological (WS-I.4.1b: no
 *     PWAtt, no personalization, no financial anything);
 *   • `sources` / `debates` — the §5.6 card-signal metrics (sourced-comment
 *     count / the WS-T corrections tally), batched over the WHOLE feasible
 *     set and handed back so the page assembly reuses the same read;
 *   • `rising` — the `attention_velocity` feature over current-schema
 *     vectors (the same stage-2 join as the ranked path, so a stale row is
 *     rebuilt rather than silently ordered as 0).
 *
 * Every ordering is complete and deterministic (`metricOrder` tie-breaks
 * chronologically) — an explicit reader choice never reshapes the safety
 * filter, only the order.
 */
async function orderFeasibleForFallback(
  services: RankingServices,
  args: FallbackArgs,
): Promise<{ ordered: Candidate[]; feasibleSignals: Map<string, StoryCardSignals> | null }> {
  if (args.userOrdering === 'sources' || args.userOrdering === 'debates') {
    const feasibleSignals = await cardSignalsForPage(
      services,
      args.feasible.map((candidate) => candidate.item_id),
    );
    const metric = new Map<string, number>();
    for (const candidate of args.feasible) {
      const signals = feasibleSignals.get(candidate.item_id);
      if (signals === undefined) continue;
      metric.set(
        candidate.item_id,
        args.userOrdering === 'sources'
          ? signals.sourced
          : signals.corrections.active +
              signals.corrections.validated +
              signals.corrections.incorrect,
      );
    }
    return { ordered: metricOrder(args.feasible, metric), feasibleSignals };
  }
  if (args.userOrdering === 'rising') {
    const features = await currentFeaturesFor(services, args.feasible, args.nowMs);
    const metric = new Map<string, number>();
    for (const candidate of args.feasible) {
      const velocity = features.get(candidate.item_id)?.attention_velocity;
      if (velocity !== undefined) metric.set(candidate.item_id, velocity);
    }
    return { ordered: metricOrder(args.feasible, metric), feasibleSignals: null };
  }
  return { ordered: chronologicalOrder(args.feasible), feasibleSignals: null };
}

/**
 * WS-I.4.1b + the user sort orders: a COMPLETE deterministic ordering over
 * the SAFETY-FILTERED set (the filter is never bypassed) — chronological for
 * every degradation reason, the mode's metric order for a `user_mode` serve —
 * and a decision log marked `fallback: true` with the honest reason and the
 * ordering that ran.
 */
async function serveFallback(
  services: RankingServices,
  request: FeedServeRequest,
  args: FallbackArgs,
): Promise<ServedFeed> {
  const orderedFeasible = await orderFeasibleForFallback(services, args);
  const ordered = orderedFeasible.ordered.slice(0, args.profile.page_size);
  // The page still carries honest §5.6 card signals — reuse the whole-set
  // read when the ordering already made it, else one batched page read (the
  // same shape as the ranked path).
  const signalsByStory =
    orderedFeasible.feasibleSignals ??
    (await cardSignalsForPage(
      services,
      ordered.map((candidate) => candidate.item_id),
    ));
  const entries: SelectedEntry[] = ordered.map((candidate) => ({
    itemId: candidate.item_id,
    score: 0,
    features: undefined,
    moreOnThisStory: [],
    signals: signalsByStory.get(candidate.item_id) ?? EMPTY_CARD_SIGNALS,
  }));
  const items = await buildFeedItems(services, entries);
  const servedIds = new Set(items.map((item) => item.story_id));
  const selectedForEvents = entries
    .filter((entry) => servedIds.has(entry.itemId))
    .map((entry) => ({ itemId: entry.itemId, score: entry.score }));
  const log = rankingDecisionLogSchema.parse({
    request_id: args.requestId,
    parent_request_id: args.parentRequestId,
    surface: request.surface,
    user_privacy_bucket: args.bucket,
    candidate_ids: [...args.candidateIds],
    selected_ids: selectedForEvents.map((s) => s.itemId),
    score_components: {},
    feature_revisions: {},
    invariant_versions: {},
    constraints_applied: args.gweiApplication === null ? [] : [args.gweiApplication],
    safety_exclusions: [...args.safetyExclusions],
    visibility_excluded_count: args.visibilityExcludedCount,
    quota_outcomes: [...args.quotaOutcomes],
    experiment_ids: [],
    timestamp: args.nowIso,
    profile_id: args.profile.profile_id,
    profile_version: args.profile.profile_version,
    feature_version: FEATURE_SCHEMA_VERSION,
    fallback: true,
    fallback_reason: args.reason,
    user_ordering: args.userOrdering,
    replay_inputs: null,
    retain_until: retentionDeadline(args.nowIso, args.retentionDays),
  });
  const logCommitted = await commitDecision(services, { log }, selectedForEvents, request.surface);
  services.log('ranking.fallback.served', {
    request_id: args.requestId,
    surface: request.surface,
    reason: args.reason,
    user_ordering: args.userOrdering,
  });
  // The fallback paginates too (deep scroll keeps working while ranking is
  // paused): same exclusion semantics, time order, honest reason per page —
  // and the same chain-link guard as the ranked path.
  const hasMore =
    logCommitted &&
    items.length > 0 &&
    args.feasible.some((candidate) => !servedIds.has(candidate.item_id));
  return {
    requestId: args.requestId,
    items,
    fallback: true,
    nextCursor: hasMore ? args.requestId : null,
  };
}

export interface ReplayResult {
  requestId: string;
  match: boolean;
  diff: ReplayDiffEntry[];
  /** Human-readable blockers (missing log, expired features, fallback). */
  problems: string[];
}

/**
 * WS-I.2.5b — replay a logged decision at its recorded versions and report
 * a structured diff. Ranked decisions replay the pure core exactly;
 * fallback decisions verify the structural invariants over the logged
 * selection (their ordering inputs are not pinned by score components).
 */
export async function replayDecision(
  services: RankingServices,
  requestId: string,
): Promise<ReplayResult> {
  const log = await services.decisionLogs.getByRequestId(requestId);
  if (log === null) {
    return { requestId, match: false, diff: [], problems: ['decision log not found'] };
  }
  const expected = log.selected_ids.map((itemId) => ({
    itemId,
    score: log.score_components[itemId]?.pwatt_score ?? 0,
  }));
  if (log.fallback || log.replay_inputs === null) {
    // Fallback decisions carry no scored inputs; replay verifies the
    // structural invariants instead: the selection came from the logged
    // candidate pool minus the safety exclusions, with no duplicates.
    const excluded = new Set(log.safety_exclusions.map((e) => e.item_id));
    const candidateSet = new Set(log.candidate_ids);
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const itemId of log.selected_ids) {
      if (!candidateSet.has(itemId)) problems.push(`selected outside the pool: ${itemId}`);
      if (excluded.has(itemId)) problems.push(`selected past the safety filter: ${itemId}`);
      if (seen.has(itemId)) problems.push(`duplicate selection: ${itemId}`);
      seen.add(itemId);
    }
    return { requestId, match: problems.length === 0, diff: [], problems };
  }
  const problems: string[] = [];
  const feasibleIds = Object.keys(log.feature_revisions);
  const features = new Map<string, FeatureVector>();
  const candidates: Candidate[] = [];
  for (const itemId of feasibleIds) {
    const revision = log.feature_revisions[itemId];
    const snapshot =
      revision === undefined ? null : await services.featureStore.getRevision(itemId, revision);
    if (snapshot === null) {
      problems.push(`feature revision unavailable for ${itemId}`);
      continue;
    }
    features.set(itemId, snapshot);
    candidates.push(
      candidateSchema.parse({
        item_id: snapshot.item_id,
        item_type: snapshot.item_type,
        source_type: 'global',
        room_id: snapshot.room_id,
        // WS-Q.4.3 — legacy snapshots default to `public` (the schema default),
        // since every pre-WS-Q served item was public.
        visibility: snapshot.visibility,
        topic_ids: snapshot.topic_ids,
        source_id: snapshot.source_id,
        freshness_timestamp: snapshot.created_at,
        retrieval_score: 0,
        retrieval_origins: ['replay'],
      }),
    );
  }
  if (problems.length > 0) {
    return { requestId, match: false, diff: [], problems };
  }
  const inputs = log.replay_inputs;
  const relevance =
    inputs.topic_relevance === null ? null : new Map(Object.entries(inputs.topic_relevance));
  const lensByItem =
    inputs.lens_by_item === null ? null : new Map(Object.entries(inputs.lens_by_item));
  const replayed = rankFeasibleSet(
    candidates,
    features,
    inputs.profile_snapshot,
    inputs.enforcement,
    {
      surface: log.surface,
      surfaceRoomId: inputs.surface_room_id,
      nowMs: Date.parse(log.timestamp),
      topicRelevanceByItem: relevance,
      userPhiRisk: inputs.user_phi_risk,
      sensitiveTopicIds: services.sensitiveTopicIds(),
      maxSourceSharePctOverride: inputs.max_source_share_pct_override,
      lensByItem,
    },
  );
  const actual = replayed.selected.map((item) => ({
    itemId: item.item_id,
    score: item.pwatt_score,
  }));
  const diff = diffRankings(expected, actual);
  const match = diff.length === 0;
  services.log('ranking.replay.completed', {
    request_id: requestId,
    match,
    diff_size: diff.length,
  });
  return { requestId, match, diff, problems: [] };
}
