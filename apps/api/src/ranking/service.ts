// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I feed service — the eight SPEC §13.3 stages composed end to end:
//
//   candidate generation (orchestrator) → feature join (feature store +
//   per-request relevance) → safety filter → constrained scoring →
//   diversification → decision logging → explanation generation → feed
//   response
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
  type ExplanationLocale,
  emptyFeatureVector,
  explainItem,
  type FallbackReason,
  type FeatureVector,
  fallbackExplanation,
  type GeneratedExplanation,
  gweiDeploymentGate,
  type RankingDecisionLog,
  type RankingProfileConfig,
  type RankingRequestContext,
  type ReplayDiffEntry,
  rankFeasibleSet,
  rankingDecisionLogSchema,
  retentionDeadline,
  type SafetyExclusion,
  type ScoiLevel,
  type ScoredItem,
  selectProfileForContext,
  topicRelevance,
} from '@licio/ranking';
import {
  deriveRatingLabel,
  deriveStorySafetyState,
  type FeedContextCard,
  type FeedItem,
  type FeedMode,
  feedItemSchema,
  rankingDecisionLoggedEventSchema,
  TOPIC_REGISTRY,
  uuidSchema,
} from '@licio/shared';
import type { NewStoredEvent } from '../events/stores.js';
import { roomContentVisibleToUser } from '../forum/rooms.js';
import type { ThreadShellRecord } from '../ingestion/stores.js';
import { makeMediaUrlMinter } from '../lib/media-urls.js';
import { feedMediaOf } from '../lib/story-media.js';
import { exposureLabelForGain, latestMeriGains } from '../routes/invariants-public.js';
import { killSwitchDecision } from './killswitch.js';
import { assembleCandidatePool } from './orchestrator.js';
import { applySafetyFilter } from './safety-filter.js';
import { type RankingServices, SEEN_HISTORY_WINDOW_MS } from './services.js';

/**
 * The locale explanations are served in. The renderer is catalog-ready
 * (`renderTemplate(id, params, locale)` with the `x-pseudo` readiness proof
 * exercised in tests); real translation catalogs slot into the @licio/ranking
 * `LOCALE_CATALOGS` map, after which this derives from the user's locale.
 */
const SERVED_EXPLANATION_LOCALE: ExplanationLocale = 'en';

export interface FeedServeRequest {
  userId: string | null;
  surface: 'front_page' | 'room' | 'topic';
  surfaceRoomId: string | null;
  /** The topic a `topic`-surface request is scoped to (`?topic=`). */
  surfaceTopicId: string | null;
  mode: FeedMode | undefined;
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

/** One selected entry on its way to the wire. */
interface SelectedEntry {
  itemId: string;
  score: number;
  explanation: GeneratedExplanation;
  features: FeatureVector | undefined;
  /** Same-cluster items demoted by dedup ("more on this story"). */
  moreOnThisStory: readonly string[];
  contextCard: FeedContextCard | null;
}

/**
 * Map selected entries onto §23.3 FeedItems with BATCHED reads: one bulk
 * story read, one bulk thread read, one bulk safety read, one lens listing
 * per distinct room, and parallel evidence counts — never per-item serial
 * round trips on the serving path.
 */
async function buildFeedItems(
  services: RankingServices,
  entries: readonly SelectedEntry[],
): Promise<FeedItem[]> {
  if (entries.length === 0) return [];
  const ids = entries.map((entry) => entry.itemId);
  const [stories, threads, safeties, meriGains] = await Promise.all([
    services.ingestion.stories.getByIds(ids),
    services.ingestion.stories.getThreadsByStoryIds(ids),
    services.events.safetyStore.getMany(ids),
    latestMeriGains(services.events),
  ]);
  const evidenceSummaries = await Promise.all(ids.map((id) => evidenceSummaryOf(services, id)));
  const lensCountByRoom = new Map<string, number>();
  for (const thread of threads.values()) {
    if (thread.roomId !== null && !lensCountByRoom.has(thread.roomId)) {
      lensCountByRoom.set(
        thread.roomId,
        (await services.forum.lenses.listByRoom(thread.roomId)).length,
      );
    }
  }
  const items: FeedItem[] = [];
  for (const [index, entry] of entries.entries()) {
    const story = stories.get(entry.itemId);
    if (story === undefined) continue;
    const thread = threads.get(entry.itemId);
    const evidence = evidenceSummaries[index] ?? { total: 0, independentVerified: 0 };
    const excerptWords = story.excerpt === null ? 0 : story.excerpt.split(/\s+/).length;
    const chips: Array<{ id: string; label: string }> = [];
    if (evidence.total > 0) {
      chips.push({
        id: 'evidence',
        label: `${evidence.total} ${evidence.total === 1 ? 'evidence card' : 'evidence cards'}`,
      });
    }
    const roomLenses = thread?.roomId != null ? (lensCountByRoom.get(thread.roomId) ?? 0) : 0;
    if (roomLenses >= 2) chips.push({ id: 'lenses', label: `${roomLenses} lenses` });
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
    const exposureLabel = exposureLabelForGain(meriGains[entry.itemId] ?? null);
    // SPEC §5.6 — the SINGLE rating-label derivation (shared with the
    // story-detail read). Live invariant signals — safety review, SCOI
    // interpretation divergence, and MERI source independence — outrank the
    // slow lifecycle state (the §10.5 principle generalised to all seven
    // labels), so e.g. a thread under coordination review reads "Under Review"
    // and a fresh thread with independent evidence reads "Well-Sourced".
    const ratingLabel = deriveRatingLabel({
      lifecycleState: story.lifecycleState,
      safetyState,
      interpretationsDiverge: entry.contextCard !== null,
      evidenceCount: evidence.independentVerified,
      meriExposure: exposureLabel,
    });
    items.push(
      feedItemSchema.parse({
        story_id: story.storyId,
        title: story.title,
        source: story.publisher ?? story.canonicalUrl ?? 'Community submission',
        origin: 'independent' as const,
        ...(story.canonicalUrl !== null ? { url: story.canonicalUrl } : {}),
        visibility: story.visibility,
        media: feedMediaOf(story, makeMediaUrlMinter()),
        reading_minutes: Math.max(1, Math.ceil(excerptWords / 200)),
        rating_label: ratingLabel,
        distribution_reason: entry.explanation.distributionReason,
        context_chips: chips,
        safety_state: safetyState,
        exposure_label: exposureLabel,
        more_on_this_story: [...entry.moreOnThisStory].slice(0, 12),
        context_card: entry.contextCard,
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
  selected: ReadonlyArray<{ itemId: string; score: number; explanation: GeneratedExplanation }>,
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
      explanation_summary: entry.explanation.distributionReason.slice(0, 500),
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
  if (scored === undefined) return ['chronological'];
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
 * Compact SCOI context cards (WS-I.2.4c) for the selected items that carry
 * the `scoi_context_card` flag: lens count from the stored SCOI row, open
 * bridge attempts from the WS-H records — bounded by page size, stored rows
 * only (never computed on request).
 */
async function contextCardsFor(
  services: RankingServices,
  selected: readonly ScoredItem[],
  featuresById: ReadonlyMap<string, FeatureVector>,
): Promise<Map<string, FeedContextCard>> {
  const out = new Map<string, FeedContextCard>();
  const flagged = selected.filter((item) => item.constraint_flags.includes('scoi_context_card'));
  if (flagged.length === 0) return out;
  const threads = await services.ingestion.stories.getThreadsByStoryIds(
    flagged.map((item) => item.item_id),
  );
  for (const item of flagged) {
    const level = featuresById.get(item.item_id)?.scoi_level;
    if (level === undefined || level === 'low') continue;
    const scoiRow = await services.events.invariantStore.latest('SCOI', item.item_id);
    const lensCount = scoiRow?.scoreVector['lens_count'];
    const thread = threads.get(item.item_id);
    const openBridges =
      thread !== undefined &&
      (await services.invariants.bridgeAttempts.openForThread(thread.threadId)) !== null
        ? 1
        : 0;
    out.set(item.item_id, {
      scoi_level: level as Exclude<ScoiLevel, 'low'>,
      lens_count: typeof lensCount === 'number' && lensCount >= 0 ? Math.floor(lensCount) : 0,
      bridge_attempts_open: openBridges,
      where_interpretations_differ: true,
    });
    services.events.metrics.increment('ranking.context_gate.card');
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
  const mode: FeedMode = request.mode ?? (user.feedModeDefault as FeedMode | null) ?? 'balanced';

  // --- Stage 1: candidate generation --------------------------------------
  const retrievalBudget = Math.max(...config.profiles.map((p) => p.candidate_budget));
  const baseProfile =
    config.profiles.find((p) => p.profile_id === 'evergreen') ?? config.profiles[0];
  if (baseProfile === undefined) throw new Error('no ranking profiles configured');
  // Local mode boosts the local quota at the CANDIDATE stage only.
  const quotaProfile: RankingProfileConfig =
    mode === 'local'
      ? {
          ...baseProfile,
          quotas: {
            ...baseProfile.quotas,
            local_min_pct: Math.min(50, baseProfile.quotas.local_min_pct * 3),
          },
        }
      : baseProfile;
  const assembled = await assembleCandidatePool(
    services.retrievers,
    services.classification,
    { ...quotaProfile, candidate_budget: retrievalBudget },
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
    const topicId = request.surfaceTopicId;
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
  let fallbackReason: FallbackReason | null = null;
  if (killSwitch.engaged) fallbackReason = 'kill_switch';
  else if (mode === 'chronological') fallbackReason = 'user_mode';
  else if (gwei.blocked && gweiOverridden === null) fallbackReason = 'gwei_gate';
  else if (safety.feasible.length === 0) fallbackReason = 'empty_pool';

  if (fallbackReason !== null) {
    return serveFallback(services, request, {
      requestId,
      parentRequestId,
      nowIso,
      bucket,
      profile,
      feasible: safety.feasible,
      candidateIds: surfacePool.map((c) => c.item_id),
      safetyExclusions: safety.exclusions,
      quotaOutcomes: assembled.quotaOutcomes,
      reason: fallbackReason,
      gweiApplication: gwei.application,
      retentionDays: config.decisionLogRetentionDays,
      visibilityExcludedCount,
    });
  }

  // --- Stage 2 (join) + 4–5 (score + diversify) ----------------------------
  const featuresById = await services.featureStore.getLatestMany(
    safety.feasible.map((c) => c.item_id),
  );
  // Cold-start write-through (WS-I.2.5b): an item the feature store has not
  // covered yet is scored on the honest EMPTY vector — which must itself be
  // a stored revision, or the decision could not be replayed at its
  // recorded versions. The empty vector carries metadata only.
  for (const candidate of safety.feasible) {
    if (featuresById.has(candidate.item_id)) continue;
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
  const personalizationOn = user.personalizationEnabled && mode !== 'low-personalization';
  let relevanceByItem: Map<string, number> | null = null;
  if (personalizationOn && request.userId !== null) {
    relevanceByItem = new Map();
    for (const candidate of safety.feasible) {
      const topics = featuresById.get(candidate.item_id)?.topic_ids ?? candidate.topic_ids;
      relevanceByItem.set(candidate.item_id, topicRelevance(topics, user.topicPreferences));
    }
  }
  const phiRisk = request.userId === null ? null : await services.userPhiRisk(request.userId);
  const sourceShareOverride =
    mode === 'source-diverse'
      ? Math.max(1, Math.floor(profile.balancing.max_source_share_pct / 2))
      : null;
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
  // Context-gate observability (WS-I.2.4c): the volume of reduced/paused
  // items feeds the dashboard that resources the bridge/expert queue.
  for (const application of ranked.applications) {
    if (application.constraint === 'scoi_reduced_distribution') {
      services.events.metrics.increment('ranking.context_gate.reduced');
    } else if (application.constraint === 'scoi_paused_pending_review') {
      services.events.metrics.increment('ranking.context_gate.paused');
    }
  }

  // --- Stage 7: explanations ------------------------------------------------
  const seen =
    request.userId === null
      ? new Map<string, string>()
      : await collectSeen(services, request.userId);
  const evidenceSummaries = await Promise.all(
    ranked.selected.map((scored) => evidenceSummaryOf(services, scored.item_id)),
  );
  const contextCards = await contextCardsFor(services, ranked.selected, featuresById);
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
  const explanationIds: Record<string, string> = {};
  const scoreComponents: Record<string, ScoredItem> = {};
  const entries: SelectedEntry[] = [];
  for (const [index, scored] of ranked.selected.entries()) {
    const features = featuresById.get(scored.item_id);
    // The "{n} independent evidence cards" template — fed the distinct verified
    // independence count so the wording is literally true (never the raw total).
    const evidenceCount = (evidenceSummaries[index] ?? { independentVerified: 0 })
      .independentVerified;
    const explanation = explainItem(
      scored,
      {
        ...(features?.scoi_level !== undefined ? { scoi_level: features.scoi_level } : {}),
        ...(features?.mfci_risk_state !== undefined
          ? { mfci_risk_state: features.mfci_risk_state }
          : {}),
      },
      {
        roomCount: 1,
        evidenceCount,
        fromDiversityQuota:
          relevanceByItem !== null &&
          user.topicPreferences.length > 0 &&
          (relevanceByItem.get(scored.item_id) ?? 0) === 0,
        previouslySeen: seen.has(scored.item_id),
      },
      SERVED_EXPLANATION_LOCALE,
    );
    explanationIds[scored.item_id] = explanation.templateId;
    scoreComponents[scored.item_id] = scored;
    entries.push({
      itemId: scored.item_id,
      score: scored.pwatt_score,
      explanation,
      features,
      moreOnThisStory: moreByItem.get(scored.item_id) ?? [],
      contextCard: contextCards.get(scored.item_id) ?? null,
    });
  }
  const items = await buildFeedItems(services, entries);
  const servedIds = new Set(items.map((item) => item.story_id));
  const selectedForEvents = entries
    .filter((entry) => servedIds.has(entry.itemId))
    .map((entry) => ({ itemId: entry.itemId, score: entry.score, explanation: entry.explanation }));

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
    explanation_ids: explanationIds,
    experiment_ids: [],
    timestamp: nowIso,
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    feature_version: 1,
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

async function collectSeen(
  services: RankingServices,
  userId: string,
): Promise<Map<string, string>> {
  const sinceIso = new Date(services.now() - SEEN_HISTORY_WINDOW_MS).toISOString();
  const seen = new Map<string, string>();
  for (const aggregate of await services.events.attentionStore.listByUserSince(userId, sinceIso)) {
    const current = seen.get(aggregate.story_id);
    if (current === undefined || aggregate.created_at > current) {
      seen.set(aggregate.story_id, aggregate.created_at);
    }
  }
  return seen;
}

/** Story-level evidence tallies used by both the §5.6 label and the chip/explanation. */
interface EvidenceSummary {
  /** ALL evidence cards on the story — the descriptive "N evidence cards" chip. */
  total: number;
  /**
   * Distinct INDEPENDENT, VERIFIED evidence units — the §5.6 "Well-Sourced" gate
   * and the "N independent evidence cards" explanation. Verified cards sharing a
   * non-null independence group (MERI §13.6) count once; an un-grouped (null)
   * verified card is its own independent unit. Unverified/disputed/retracted
   * cards never count toward independence, so a thread is "Well-Sourced" only on
   * genuinely independent, verified evidence — not on repeated or unchecked cards.
   */
  independentVerified: number;
}

async function evidenceSummaryOf(
  services: RankingServices,
  storyId: string,
): Promise<EvidenceSummary> {
  let total = 0;
  const verifiedGroups = new Set<string>();
  let ungroupedVerified = 0;
  for (const claim of await services.ingestion.claims.listByStory(storyId)) {
    for (const card of await services.ingestion.evidence.listByClaim(claim.claimId)) {
      total += 1;
      if (card.verificationState !== 'verified') continue;
      if (card.independenceGroupId === null) ungroupedVerified += 1;
      else verifiedGroups.add(card.independenceGroupId);
    }
  }
  return { total, independentVerified: verifiedGroups.size + ungroupedVerified };
}

interface FallbackArgs {
  requestId: string;
  parentRequestId: string | null;
  nowIso: string;
  bucket: string;
  profile: RankingProfileConfig;
  feasible: readonly Candidate[];
  candidateIds: readonly string[];
  safetyExclusions: readonly SafetyExclusion[];
  quotaOutcomes: RankingDecisionLog['quota_outcomes'];
  reason: FallbackReason;
  gweiApplication: RankingDecisionLog['constraints_applied'][number] | null;
  retentionDays: number;
  /** WS-Q.4.2b — visibility-gate drops (the gate ran before the ranked/fallback
   *  split, so this count is identical on both paths). */
  visibilityExcludedCount: number;
}

/**
 * WS-I.4.1b — the safe fallback ranker: chronological ordering over the
 * SAFETY-FILTERED set (the filter is never bypassed), no PWAtt, no
 * personalization, no financial anything; an honest "time order"
 * explanation; and a decision log marked `fallback: true`.
 */
async function serveFallback(
  services: RankingServices,
  request: FeedServeRequest,
  args: FallbackArgs,
): Promise<ServedFeed> {
  const ordered = chronologicalOrder(args.feasible).slice(0, args.profile.page_size);
  const explanation = fallbackExplanation(args.reason, SERVED_EXPLANATION_LOCALE);
  const entries: SelectedEntry[] = ordered.map((candidate) => ({
    itemId: candidate.item_id,
    score: 0,
    explanation,
    features: undefined,
    moreOnThisStory: [],
    contextCard: null,
  }));
  const items = await buildFeedItems(services, entries);
  const servedIds = new Set(items.map((item) => item.story_id));
  const selectedForEvents = entries
    .filter((entry) => servedIds.has(entry.itemId))
    .map((entry) => ({ itemId: entry.itemId, score: entry.score, explanation: entry.explanation }));
  const explanationIds: Record<string, string> = {};
  for (const entry of selectedForEvents) explanationIds[entry.itemId] = explanation.templateId;
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
    explanation_ids: explanationIds,
    experiment_ids: [],
    timestamp: args.nowIso,
    profile_id: args.profile.profile_id,
    profile_version: args.profile.profile_version,
    feature_version: 1,
    fallback: true,
    fallback_reason: args.reason,
    replay_inputs: null,
    retain_until: retentionDeadline(args.nowIso, args.retentionDays),
  });
  const logCommitted = await commitDecision(services, { log }, selectedForEvents, request.surface);
  services.log('ranking.fallback.served', {
    request_id: args.requestId,
    surface: request.surface,
    reason: args.reason,
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
        bridge_context: null,
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
