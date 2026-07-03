// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I injectable service container (the WS-E/F/G/H house pattern):
// in-memory stores by default, production Drizzle adapters swapped in at
// boot, the fail-closed runtime config, the retriever registry over narrow
// read-only ports, the WS-J moderation seam, and the durable feature-store
// consumer registered once.
//
// PAY-TO-RANK BOUNDARY: nothing in this container reads any wallet, payment,
// treasury, donor, or membership store — the ports composed here touch only
// ingestion/forum/events/invariants stores, and the neutrality suite
// (WS-I.3) asserts both the import graph and runtime equivalence.

import { createHash } from 'node:crypto';
import { InvariantType } from '@licio/invariants';
import type { RankingEnforcement } from '@licio/ranking';
import { TOPIC_ID_BY_SLUG } from '@licio/shared';
import { type EventPipelineServices, getEventPipelineServices } from '../events/services.js';
import { type ForumServices, getForumServices } from '../forum/services.js';
import { accountRef } from '../identity/crypto.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { getIngestionServices, type IngestionServices } from '../ingestion/services.js';
import {
  createInMemoryInvariantServices,
  getInvariantServices,
  type InvariantPlatformServices,
  phiSessionTargetId,
  setInvariantServices,
} from '../invariants/services.js';
import {
  DEFAULT_RANKING_CONFIG,
  loadRankingRuntimeConfig,
  type RankingRuntimeConfig,
} from './config.js';
import {
  type FeatureAssemblyDeps,
  pwattRowForRanking,
  refreshFeatures,
  registerFeatureStoreConsumer,
} from './features.js';
import type { ClassificationPorts } from './orchestrator.js';
import {
  type CandidateDataPorts,
  createDefaultRetrievers,
  type RetrieverRegistry,
} from './retrievers.js';
import {
  createDefaultModerationStateProvider,
  type ModerationStateProvider,
} from './safety-filter.js';
import {
  type DecisionLogStore,
  type FeatureStore,
  InMemoryDecisionLogStore,
  InMemoryFeatureStore,
} from './stores.js';

/** Per-request user context resolved from WS-D (never financial fields). */
export interface RankingUserContext {
  userId: string | null;
  ageBand: 'adult' | 'teen_16_17' | 'teen_13_15' | null;
  personalizationEnabled: boolean;
  topicPreferences: readonly string[];
  feedModeDefault: string | null;
}

export interface RankingServices {
  featureStore: FeatureStore;
  decisionLogs: DecisionLogStore;
  retrievers: RetrieverRegistry;
  classification: ClassificationPorts;
  moderation: ModerationStateProvider;
  config: () => RankingRuntimeConfig;
  reloadConfig: () => Promise<RankingRuntimeConfig>;
  /** WS-H.1.2e promotion flags for every effect-bearing invariant. */
  enforcement: () => Promise<RankingEnforcement>;
  /** The requesting user's own latest PHI risk (null = none computed). */
  userPhiRisk: (userId: string) => Promise<number | null>;
  userContext: (userId: string | null) => Promise<RankingUserContext>;
  /** Anonymized requester cohort: `bucket:<2 hex>` or `anonymous`. */
  privacyBucket: (userId: string | null) => string;
  /** Topic ids treated as sensitive (stricter PHI thresholds; WS-A list). */
  sensitiveTopicIds: () => ReadonlySet<string>;
  /** Latest GWEI cohort disparity (max over cohort pairs), for the gate. */
  latestGweiDisparity: () => Promise<number | null>;
  /** Background work tracked for test flushing (house pattern). */
  trackBackground: (work: Promise<unknown>) => void;
  flushBackground: () => Promise<void>;
  events: EventPipelineServices;
  ingestion: IngestionServices;
  forum: ForumServices;
  invariants: InvariantPlatformServices;
  identity: IdentityServices;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export interface RankingServicesOptions {
  log?: (event: string, meta: Record<string, unknown>) => void;
  now?: () => number;
  /** Override the sensitive-topic list (defaults to the WS-A categories). */
  sensitiveTopicIds?: ReadonlySet<string>;
}

/** Seen-history horizon for the serving-path reads (catch-up/freshness). */
export const SEEN_HISTORY_WINDOW_MS = 30 * 24 * 3_600_000;

/** PHI lookback: sessions whose aggregates landed in this window count. */
export const PHI_SESSION_WINDOW_MS = 7 * 24 * 3_600_000;

/** Max distinct recent session buckets consulted for the user PHI risk. */
export const PHI_SESSION_BUCKET_CAP = 8;

/** GWEI-gate read cache TTL (the serving path pays ≤ 1 query per minute). */
export const GWEI_CACHE_TTL_MS = 60_000;

/**
 * SURFACE-level sensitive-topic SLUGS (§11.5): a `?topic=<slug>` surface on one
 * of these selects the conservative profile. This is a topic-SLUG set matched
 * against `surfaceTopicId` (the raw `?topic=` value). PER-ITEM sensitivity is
 * NOT topic-driven — an item's content sensitivity rides its WS-F
 * `sensitivity_labels` (wired into the feature vector), because per-item topics
 * are catalog UUIDs, not these slugs. A deployment may add catalog topic UUIDs
 * here to also mark specific topics sensitive per item (the forward-compat hook
 * in `scoreItem`).
 */
export const DEFAULT_SENSITIVE_TOPIC_IDS: ReadonlySet<string> = new Set([
  'self-harm',
  'eating-disorders',
  'medical-misinformation',
  'extremist-ideology',
  'harassment',
]);

/** Compose the read-only candidate data ports over the existing stores. */
export function createCandidateDataPorts(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  forum: ForumServices,
  identity: IdentityServices,
  now: () => number = Date.now,
): CandidateDataPorts {
  return {
    recentStories: (limit) => ingestion.stories.listRecent(limit),
    storyById: (storyId) => ingestion.stories.getById(storyId),
    threadByStoryId: (storyId) => ingestion.stories.getThreadByStoryId(storyId),
    storyIdByThreadId: (threadId) => ingestion.stories.getStoryIdByThreadId(threadId),
    async subscribedRoomIds(userId) {
      const subscriptions = await forum.rooms.listSubscriptionsByUser(userId);
      return subscriptions.filter((s) => s.status === 'active').map((s) => s.roomId);
    },
    threadsByRoom: (roomId, limit) => ingestion.stories.listThreadsByRoom(roomId, null, limit),
    async expertLedRoomIds(limit) {
      // WS-Q.4.1b — the successor to legacy `expert_led` rooms on the front
      // page is a PUBLIC room with the `experts_and_stewards` posting policy
      // (private rooms force room_only and never reach the public surface). The
      // global predicate on the retriever then keeps only its public content.
      const rooms = await forum.rooms.list({ visibilities: ['public'], limit: limit * 8 });
      return rooms
        .filter((r) => r.postingPolicy === 'experts_and_stewards')
        .slice(0, limit)
        .map((r) => r.roomId);
    },
    async roomVisibility(roomId) {
      const room = await forum.rooms.getById(roomId);
      return room === null ? null : room.visibility;
    },
    async roomStorageMode(roomId) {
      const room = await forum.rooms.getById(roomId);
      return room === null ? null : room.storageMode;
    },
    async userSeenStories(userId) {
      // Bounded to the catch-up horizon (30d): seen-history serves the
      // recent-items retrievers, and an unbounded scan of a heavy reader's
      // whole history is a serving-path cost with no product effect.
      const sinceIso = new Date(now() - SEEN_HISTORY_WINDOW_MS).toISOString();
      const seen = new Map<string, string>();
      for (const aggregate of await events.attentionStore.listByUserSince(userId, sinceIso)) {
        const current = seen.get(aggregate.story_id);
        if (current === undefined || aggregate.created_at > current) {
          seen.set(aggregate.story_id, aggregate.created_at);
        }
      }
      return seen;
    },
    async latestScoi(storyId) {
      const row = await events.invariantStore.latest('SCOI', storyId);
      if (row === null) return null;
      const scoi = row.scoreVector['scoi'];
      const state = row.scoreVector['context_state'];
      const lensCount = row.scoreVector['lens_count'];
      if (typeof scoi !== 'number' || typeof state !== 'string') return null;
      return {
        scoi,
        contextState: state,
        lensCount: typeof lensCount === 'number' ? lensCount : 0,
      };
    },
    async latestPwattComponents(storyId) {
      // The retrieval leg reads PWAtt through the SAME §30.5 bounded-input gate
      // as the feature join (WS-I.2.1d): the lift constant + the row's own
      // shadow_mode + the degraded⇒ABSENT rule. A pre-lift/shadow/degraded row
      // is ABSENT here too, so a §30.5 revert or a compute failure withholds
      // PWAtt from candidate eligibility AND scoring, never only from scoring.
      const row =
        pwattRowForRanking(await events.invariantStore.latest('PWAtt_v1', storyId)) ??
        pwattRowForRanking(await events.invariantStore.latest('PWAtt_v0', storyId));
      if (row === null) return null;
      const attention = row.scoreVector['active_attention'];
      const participation = row.scoreVector['participation'];
      if (typeof attention !== 'number' || typeof participation !== 'number') return null;
      return { activeAttention: attention, participation };
    },
    async latestDayWindow(itemId) {
      const nowIso = new Date(now()).toISOString();
      const windows = await events.windowStore.listForItemBefore(itemId, '24h', nowIso, 1);
      return windows[0] ?? null;
    },
    async hasHumanSummary(threadId) {
      const summaries = await forum.summaries.listByThread(threadId);
      return summaries.some(
        (s) => s.layer === 'steward_summary' || s.layer === 'community_synthesis',
      );
    },
    async evidenceCountByStory(storyId) {
      let count = 0;
      for (const claim of await ingestion.claims.listByStory(storyId)) {
        count += (await ingestion.evidence.listByClaim(claim.claimId)).length;
      }
      return count;
    },
    async userLocale(userId) {
      const user = await identity.store.getUser(userId);
      return user?.locale ?? null;
    },
  };
}

/** Compose the quota classification ports (fresh/independent sources). */
export function createClassificationPorts(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  now: () => number = Date.now,
): ClassificationPorts {
  return {
    async seenSourceIds(userId) {
      const sources = new Set<string>();
      if (userId === null) return sources;
      const sinceIso = new Date(now() - SEEN_HISTORY_WINDOW_MS).toISOString();
      const aggregates = await events.attentionStore.listByUserSince(userId, sinceIso);
      const stories = await ingestion.stories.getByIds([
        ...new Set(aggregates.map((a) => a.story_id)),
      ]);
      for (const story of stories.values()) {
        if (story.sourceId !== null) sources.add(story.sourceId);
      }
      return sources;
    },
    async isSyndicationCopy(sourceId) {
      const edges = await ingestion.syndications.listForSource(sourceId);
      // A CONFIRMED edge whose destination (copy side) is this source.
      return edges.some((e) => e.status === 'confirmed' && e.toSourceId === sourceId);
    },
  };
}

export function createInMemoryRankingServices(
  events: EventPipelineServices,
  identity: IdentityServices,
  ingestion: IngestionServices,
  forum: ForumServices,
  invariants: InvariantPlatformServices,
  options: RankingServicesOptions = {},
): RankingServices {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  let runtimeConfig: RankingRuntimeConfig = DEFAULT_RANKING_CONFIG;
  const sensitiveTopics = options.sensitiveTopicIds ?? DEFAULT_SENSITIVE_TOPIC_IDS;
  const background = new Set<Promise<unknown>>();

  const ports = createCandidateDataPorts(events, ingestion, forum, identity, now);
  let gweiCache: { value: number | null; atMs: number } | null = null;
  const services: RankingServices = {
    featureStore: new InMemoryFeatureStore(),
    decisionLogs: new InMemoryDecisionLogStore(),
    retrievers: createDefaultRetrievers(ports),
    classification: createClassificationPorts(events, ingestion, now),
    moderation: createDefaultModerationStateProvider({
      events,
      stories: ingestion.stories,
      // No-op by default (no moderation store wired) → ranking stays closure-
      // clean for the neutrality gate.  Boot late-binds the real WS-J query.
      shadowedSubjects: async () => new Set(),
    }),
    config: () => runtimeConfig,
    reloadConfig: async () => {
      runtimeConfig = await loadRankingRuntimeConfig(events);
      gweiCache = null; // the gate window may have changed
      return runtimeConfig;
    },
    async enforcement(): Promise<RankingEnforcement> {
      const gate = invariants.promotionService;
      const [mfci, phi, scoi, gwei, meri, hodge, tropical] = await Promise.all([
        gate.effectsEnabled(InvariantType.MFCI),
        gate.effectsEnabled(InvariantType.PHI),
        gate.effectsEnabled(InvariantType.SCOI),
        gate.effectsEnabled(InvariantType.GWEI),
        gate.effectsEnabled(InvariantType.MERI),
        gate.effectsEnabled(InvariantType.HodgeTension),
        gate.effectsEnabled(InvariantType.TropicalCascade),
      ]);
      return { mfci, phi, scoi, gwei, meri, hodge, tropical };
    },
    async userPhiRisk(userId) {
      // The requesting user's OWN PHI outputs: the MAX holonomy over their
      // recent session buckets (a single-latest-session read missed an
      // older high-holonomy session that should still diversify the feed).
      // Buckets derive from the user's own aggregates via the same opaque
      // digest the PHI tier writes; bounded by window + bucket cap.
      const sinceIso = new Date(now() - PHI_SESSION_WINDOW_MS).toISOString();
      const aggregates = await events.attentionStore.listByUserSince(userId, sinceIso);
      const buckets: string[] = [];
      for (const aggregate of aggregates.sort((a, b) => b.created_at.localeCompare(a.created_at))) {
        if (!buckets.includes(aggregate.session_bucket)) buckets.push(aggregate.session_bucket);
        if (buckets.length >= PHI_SESSION_BUCKET_CAP) break;
      }
      let max: number | null = null;
      for (const bucket of buckets) {
        const row = await events.invariantStore.latest('PHI', phiSessionTargetId(userId, bucket));
        const phi = row?.scoreVector['phi'];
        if (typeof phi === 'number' && Number.isFinite(phi)) {
          max = max === null ? phi : Math.max(max, phi);
        }
      }
      return max;
    },
    async userContext(userId) {
      if (userId === null) {
        return {
          userId: null,
          ageBand: null,
          personalizationEnabled: false,
          topicPreferences: [],
          feedModeDefault: null,
        };
      }
      const user = await identity.store.getUser(userId);
      if (user === null) {
        return {
          userId,
          ageBand: null,
          personalizationEnabled: false,
          topicPreferences: [],
          feedModeDefault: null,
        };
      }
      return {
        userId,
        ageBand: user.ageBand,
        personalizationEnabled: user.privacySettings.personalization_enabled,
        // Resolve stored preference SLUGS to catalog UUIDs so they match
        // candidates' trusted catalog topic ids (UUIDs) in `topicRelevance`; an
        // unknown value (already a UUID, or off-catalog) passes through.
        topicPreferences: user.personalizationSettings.topic_preferences.map(
          (p) => TOPIC_ID_BY_SLUG.get(p) ?? p,
        ),
        feedModeDefault: user.personalizationSettings.feed_mode,
      };
    },
    privacyBucket(userId) {
      if (userId === null) return 'anonymous';
      // Keyed, non-reversible cohort: 256 buckets over the account ref —
      // coarse enough that a bucket is never an identifier (WS-I.2.5a).
      const ref = accountRef(identity.config.masterSecret, userId);
      return `bucket:${createHash('sha256').update(ref).digest('hex').slice(0, 2)}`;
    },
    sensitiveTopicIds: () => sensitiveTopics,
    async latestGweiDisparity() {
      // The gate input: max upper-bound disparity (gw2 is already an exact-
      // marginal UPPER bound, WS-H.5) over RECENT GWEI rows — a targeted,
      // recency-windowed read (never a table scan), skipping k-anonymity-
      // suppressed rows (a suppressed cohort is "withheld", not "zero" and
      // not "infinite"), TTL-cached so the serving path pays one query per
      // minute, not one per request.
      const nowMs = now();
      if (gweiCache !== null && nowMs - gweiCache.atMs < GWEI_CACHE_TTL_MS) {
        return gweiCache.value;
      }
      const config = services.config();
      const sinceIso = new Date(nowMs - config.gweiGateWindowHours * 3_600_000).toISOString();
      const rows = await events.invariantStore.listByTypeSince('GWEI', sinceIso, 500);
      let max: number | null = null;
      for (const row of rows) {
        if (row.reasonCodes.some((code) => code.includes('SUPPRESSED'))) continue;
        const value = row.scoreVector['gw2'];
        if (typeof value === 'number' && Number.isFinite(value)) {
          max = max === null ? value : Math.max(max, value);
        }
      }
      // A null result is never cached: until the first GWEI row exists the
      // query is an empty indexed read, and caching the negative would
      // delay the gate's FIRST engagement by up to the TTL.
      if (max !== null) gweiCache = { value: max, atMs: nowMs };
      return max;
    },
    trackBackground(work) {
      background.add(work);
      void work.finally(() => background.delete(work));
    },
    async flushBackground() {
      await Promise.allSettled([...background]);
    },
    events,
    ingestion,
    forum,
    invariants,
    identity,
    log,
    now,
  };
  return services;
}

/** Register the WS-I durable consumers (feature-store real-time path). */
function featureAssemblyDeps(services: RankingServices): FeatureAssemblyDeps {
  return {
    events: services.events,
    ingestion: services.ingestion,
    invariants: services.invariants,
    featureStore: services.featureStore,
    log: services.log,
    now: services.now,
  };
}

export function registerRankingConsumers(services: RankingServices): void {
  registerFeatureStoreConsumer(featureAssemblyDeps(services));
}

/**
 * Refresh ONE story's ranking feature vector on demand — e.g. after the WS-K
 * topic-validation pass promotes the trusted topics — so a cold-start empty
 * revision (written when the story was served while classification was still
 * pending) does not shadow the validated topics + sensitivity labels until the
 * hourly batch. Assembles from the CURRENT story, so it picks up the validated
 * state. Best-effort; a failure leaves the batch path to catch up.
 */
export async function refreshStoryFeatures(
  services: RankingServices,
  storyId: string,
): Promise<void> {
  await refreshFeatures(featureAssemblyDeps(services), storyId);
}

// --- Module singleton (house pattern) ---------------------------------------

let _services: RankingServices | undefined;

export function getRankingServices(): RankingServices {
  if (_services) return _services;
  if (process.env['NODE_ENV'] === 'test') {
    // The lazy test fallback composes from the sibling singletons (each has
    // its own test fallback). Consumers are NOT registered here — a test
    // exercising the real-time path registers them on its own fixture.
    const events = getEventPipelineServices();
    const identity = getIdentityServices();
    const ingestion = getIngestionServices();
    const forum = getForumServices();
    let invariants: InvariantPlatformServices;
    try {
      invariants = getInvariantServices();
    } catch {
      invariants = createInMemoryInvariantServices(events, identity, ingestion, forum);
      setInvariantServices(invariants);
    }
    _services = createInMemoryRankingServices(events, identity, ingestion, forum, invariants);
    return _services;
  }
  throw new Error('Ranking services not configured — call setRankingServices() at startup');
}

export function setRankingServices(services: RankingServices): void {
  _services = services;
}

/** Test helper: drop the singleton between cases. */
export function resetRankingServices(): void {
  _services = undefined;
}
