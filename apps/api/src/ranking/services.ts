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
import { type FeatureAssemblyDeps, registerFeatureStoreConsumer } from './features.js';
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

/** WS-A sensitive-topic categories with stricter PHI thresholds (§11.5). */
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
      const rooms = await forum.rooms.list({ visibilities: ['expert_led'], limit });
      return rooms.map((r) => r.roomId);
    },
    async userSeenStories(userId) {
      const seen = new Map<string, string>();
      for (const aggregate of await events.attentionStore.listByUser(userId)) {
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
      const row =
        (await events.invariantStore.latest('PWAtt_v1', storyId)) ??
        (await events.invariantStore.latest('PWAtt_v0', storyId));
      if (row === null) return null;
      const attention = row.scoreVector['active_attention'];
      const participation = row.scoreVector['participation'];
      if (typeof attention !== 'number' || typeof participation !== 'number') return null;
      return { activeAttention: attention, participation };
    },
    async latestDayWindow(itemId) {
      const nowIso = new Date(Date.now()).toISOString();
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
): ClassificationPorts {
  return {
    async seenSourceIds(userId) {
      const sources = new Set<string>();
      if (userId === null) return sources;
      for (const aggregate of await events.attentionStore.listByUser(userId)) {
        const story = await ingestion.stories.getById(aggregate.story_id);
        if (story?.sourceId != null) sources.add(story.sourceId);
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

  const ports = createCandidateDataPorts(events, ingestion, forum, identity);
  const services: RankingServices = {
    featureStore: new InMemoryFeatureStore(),
    decisionLogs: new InMemoryDecisionLogStore(),
    retrievers: createDefaultRetrievers(ports),
    classification: createClassificationPorts(events, ingestion),
    moderation: createDefaultModerationStateProvider({ events, stories: ingestion.stories }),
    config: () => runtimeConfig,
    reloadConfig: async () => {
      runtimeConfig = await loadRankingRuntimeConfig(events);
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
      // The requesting user's OWN latest PHI output: their most recent
      // session bucket → the same opaque target id the PHI tier writes.
      const aggregates = await events.attentionStore.listByUser(userId);
      const latest = aggregates.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (latest === undefined) return null;
      const row = await events.invariantStore.latest(
        'PHI',
        phiSessionTargetId(userId, latest.session_bucket),
      );
      const phi = row?.scoreVector['phi'];
      return typeof phi === 'number' && Number.isFinite(phi) ? phi : null;
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
        topicPreferences: user.personalizationSettings.topic_preferences,
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
      // Max upper-bound disparity over the latest GWEI outputs (the gate
      // input). Suppressed/absent cohorts simply do not contribute.
      const rows = (await events.invariantStore.listAll()).filter(
        (row) => row.invariantType === 'GWEI',
      );
      let max: number | null = null;
      for (const row of rows) {
        const value = row.scoreVector['gw2'];
        if (typeof value === 'number' && Number.isFinite(value)) {
          max = max === null ? value : Math.max(max, value);
        }
      }
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
export function registerRankingConsumers(services: RankingServices): void {
  const deps: FeatureAssemblyDeps = {
    events: services.events,
    ingestion: services.ingestion,
    invariants: services.invariants,
    featureStore: services.featureStore,
    log: services.log,
    now: services.now,
  };
  registerFeatureStoreConsumer(deps);
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
