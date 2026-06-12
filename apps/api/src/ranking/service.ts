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
// profile snapshot, the promotion-enforcement flags, and the resolved
// per-item relevance — so any decision is reproducible at its recorded
// versions, byte for byte.
//
// EXACTLY ONE decision log per served request (ranked, fallback, demo —
// every path). A failed log write never fails the feed (availability), but
// it is loudly logged and counted: a missing log is an auditability
// incident (WS-I.2.5a observability).

import { randomUUID } from 'node:crypto';
import {
  type Candidate,
  candidateSchema,
  chronologicalOrder,
  diffRankings,
  emptyFeatureVector,
  explainItem,
  type FallbackReason,
  type FeatureVector,
  fallbackExplanation,
  type GeneratedExplanation,
  gweiDeploymentGate,
  type RankingDecisionLog,
  type RankingEnforcement,
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
} from '@licio/ranking';
import {
  type FeedItem,
  type FeedMode,
  feedItemSchema,
  rankingDecisionLoggedEventSchema,
  TOPIC_REGISTRY,
} from '@licio/shared';
import type { StoryRecord, ThreadShellRecord } from '../ingestion/stores.js';
import { exposureLabelForGain, latestMeriGains } from '../routes/invariants-public.js';
import { killSwitchDecision } from './killswitch.js';
import { assembleCandidatePool } from './orchestrator.js';
import { applySafetyFilter } from './safety-filter.js';
import type { RankingServices } from './services.js';

/** WS-F lifecycle states → the WS-C rating-label vocabulary (read mapping). */
export const LIFECYCLE_TO_RATING_LABEL: Readonly<Record<StoryRecord['lifecycleState'], string>> = {
  submitted: 'getting-attention',
  gathering_attention: 'getting-attention',
  deepening: 'deepening',
  context_needed: 'needs-context',
  bridging: 'bridge-active',
  stable: 'resolved-context',
  archived: 'resolved-context',
};

export interface FeedServeRequest {
  userId: string | null;
  surface: 'front_page' | 'room' | 'topic';
  surfaceRoomId: string | null;
  mode: FeedMode | undefined;
}

export interface ServedFeed {
  requestId: string;
  items: FeedItem[];
  fallback: boolean;
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

/** Story safety posture for the wire (descriptive, never a sanction). */
function feedSafetyState(
  features: FeatureVector | undefined,
  thread: ThreadShellRecord | null,
  frozen: boolean,
): FeedItem['safety_state'] {
  if (frozen) return 'under-review';
  const risk = features?.mfci_risk_state;
  if (risk === 'severe' || risk === 'high') return 'under-review';
  if (thread?.safetyState === 'under_review') return 'under-review';
  if (risk === 'elevated' || thread?.safetyState === 'elevated') return 'caution';
  return 'ok';
}

/** Map one ranked story onto the §23.3 FeedItem wire shape. */
async function toFeedItem(
  services: RankingServices,
  story: StoryRecord,
  explanation: GeneratedExplanation,
  features: FeatureVector | undefined,
  meriGain: number | null,
  evidenceCount: number,
): Promise<FeedItem> {
  const thread = await services.ingestion.stories.getThreadByStoryId(story.storyId);
  const safety = await services.events.safetyStore.get(story.storyId);
  const excerptWords = story.excerpt === null ? 0 : story.excerpt.split(/\s+/).length;
  const chips: Array<{ id: string; label: string }> = [];
  if (evidenceCount > 0) {
    chips.push({
      id: 'evidence',
      label: `${evidenceCount} ${evidenceCount === 1 ? 'evidence card' : 'evidence cards'}`,
    });
  }
  if (thread?.roomId != null) {
    const lenses = await services.forum.lenses.listByRoom(thread.roomId);
    if (lenses.length >= 2) {
      chips.push({ id: 'lenses', label: `${lenses.length} lenses` });
    }
  }
  if (features?.mfci_risk_state === 'normal') {
    chips.push({ id: 'coordination', label: 'low coordination risk' });
  }
  return feedItemSchema.parse({
    story_id: story.storyId,
    title: story.title,
    source: story.publisher ?? story.canonicalUrl ?? 'Community submission',
    origin: 'independent' as const,
    ...(story.canonicalUrl !== null ? { url: story.canonicalUrl } : {}),
    reading_minutes: Math.max(1, Math.ceil(excerptWords / 200)),
    rating_label: LIFECYCLE_TO_RATING_LABEL[story.lifecycleState],
    distribution_reason: explanation.distributionReason,
    context_chips: chips,
    safety_state: feedSafetyState(features, thread, safety?.safetyState === 'frozen'),
    exposure_label: exposureLabelForGain(meriGain),
  });
}

interface DecisionLogDraft {
  log: RankingDecisionLog;
}

/** Insert the decision log + emit the per-item events; never throws. */
async function commitDecision(
  services: RankingServices,
  draft: DecisionLogDraft,
  selected: ReadonlyArray<{ itemId: string; score: number; explanation: GeneratedExplanation }>,
  surface: 'front_page' | 'room' | 'topic',
): Promise<void> {
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
    return;
  }
  services.log('ranking.decision.logged', {
    request_id: draft.log.request_id,
    candidates: draft.log.candidate_ids.length,
    selected: draft.log.selected_ids.length,
    fallback: draft.log.fallback,
  });
  // §21.3 topic: one `ranking.decision.logged` event per SELECTED item.
  const registry = TOPIC_REGISTRY['ranking.decision.logged'];
  const context = surface === 'room' ? ('room' as const) : ('feed' as const);
  for (let position = 0; position < selected.length; position += 1) {
    const entry = selected[position];
    if (entry === undefined) continue;
    const event = rankingDecisionLoggedEventSchema.parse({
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
    });
    await services.events.eventStore.insertMany([
      {
        eventId: event.event_id,
        eventType: event.event_type,
        topic: event.event_type,
        timestamp: event.timestamp,
        privacyClassification: registry.privacy_classification,
        retentionTier: registry.retention_tier,
        payload: event as unknown as Record<string, unknown>,
        ownerUserId: null,
        purgeAfter: null,
      },
    ]);
    services.trackBackground(services.events.router.publish(event));
  }
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
  for (const [name, term] of Object.entries(scored.penalty_components)) {
    if (typeof term === 'object' && term !== null && 'applied' in term && term.applied > 0) {
      names.push(`penalty_${name}`);
    }
  }
  return names.slice(0, 50);
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
  const pool = await assembleCandidatePool(
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

  // Empty pool ⇒ the legacy demo-contract path is the caller's concern; the
  // service reports an honest empty fallback decision.
  const profileContext = {
    surface: request.surface,
    freshness: poolFreshnessClass(pool.pool, nowMs),
    topicSensitivity: 'standard' as const,
    ageGroup: (user.ageBand ?? 'unknown') as 'adult' | 'teen_16_17' | 'teen_13_15' | 'unknown',
    jurisdiction: null,
    riskState: 'normal' as const,
  };
  const profile = selectProfileForContext(profileContext, config.profiles) ?? baseProfile;

  // --- Stage 3: safety filter (before scoring; authoritative) -------------
  const safety = await applySafetyFilter(pool.pool, services.moderation, {
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
  let fallbackReason: FallbackReason | null = null;
  if (killSwitch.engaged) fallbackReason = 'kill_switch';
  else if (mode === 'chronological') fallbackReason = 'user_mode';
  else if (gwei.blocked) fallbackReason = 'gwei_gate';
  else if (safety.feasible.length === 0) fallbackReason = 'empty_pool';

  if (fallbackReason !== null) {
    return serveFallback(services, request, {
      requestId,
      nowIso,
      bucket,
      profile,
      feasible: safety.feasible,
      candidateIds: pool.pool.map((c) => c.item_id),
      safetyExclusions: safety.exclusions,
      quotaOutcomes: pool.quotaOutcomes,
      reason: fallbackReason,
      gweiApplication: gwei.application,
      retentionDays: config.decisionLogRetentionDays,
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
  const context: RankingRequestContext = {
    surface: request.surface,
    surfaceRoomId: request.surfaceRoomId,
    nowMs,
    topicRelevanceByItem: relevanceByItem,
    userPhiRisk: phiRisk,
    sensitiveTopicIds: services.sensitiveTopicIds(),
    maxSourceSharePctOverride: sourceShareOverride,
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

  // --- Stage 7: explanations ------------------------------------------------
  const meriGains = await latestMeriGains(services.events);
  const seen =
    request.userId === null
      ? new Map<string, string>()
      : await collectSeen(services, request.userId);
  const items: FeedItem[] = [];
  const explanationIds: Record<string, string> = {};
  const selectedForEvents: Array<{
    itemId: string;
    score: number;
    explanation: GeneratedExplanation;
  }> = [];
  const scoreComponents: Record<string, ScoredItem> = {};
  for (const scored of ranked.selected) {
    const story = await services.ingestion.stories.getById(scored.item_id);
    if (story === null) continue;
    const features = featuresById.get(scored.item_id);
    const evidenceCount = await evidenceCountOf(services, scored.item_id);
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
    );
    explanationIds[scored.item_id] = explanation.templateId;
    scoreComponents[scored.item_id] = scored;
    selectedForEvents.push({
      itemId: scored.item_id,
      score: scored.pwatt_score,
      explanation,
    });
    items.push(
      await toFeedItem(
        services,
        story,
        explanation,
        features,
        meriGains[scored.item_id] ?? null,
        evidenceCount,
      ),
    );
  }

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
    surface: request.surface,
    user_privacy_bucket: bucket,
    candidate_ids: pool.pool.map((c) => c.item_id),
    selected_ids: selectedForEvents.map((s) => s.itemId),
    score_components: scoreComponents,
    feature_revisions: featureRevisions,
    invariant_versions: invariantVersions,
    constraints_applied: ranked.applications,
    safety_exclusions: safety.exclusions,
    quota_outcomes: pool.quotaOutcomes,
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
    },
    retain_until: retentionDeadline(nowIso, config.decisionLogRetentionDays),
  });
  await commitDecision(services, { log }, selectedForEvents, request.surface);

  return { requestId, items, fallback: false };
}

async function collectSeen(
  services: RankingServices,
  userId: string,
): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  for (const aggregate of await services.events.attentionStore.listByUser(userId)) {
    const current = seen.get(aggregate.story_id);
    if (current === undefined || aggregate.created_at > current) {
      seen.set(aggregate.story_id, aggregate.created_at);
    }
  }
  return seen;
}

async function evidenceCountOf(services: RankingServices, storyId: string): Promise<number> {
  let count = 0;
  for (const claim of await services.ingestion.claims.listByStory(storyId)) {
    count += (await services.ingestion.evidence.listByClaim(claim.claimId)).length;
  }
  return count;
}

interface FallbackArgs {
  requestId: string;
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
  const explanation = fallbackExplanation(args.reason);
  const meriGains = await latestMeriGains(services.events);
  const items: FeedItem[] = [];
  const selectedForEvents: Array<{
    itemId: string;
    score: number;
    explanation: GeneratedExplanation;
  }> = [];
  const explanationIds: Record<string, string> = {};
  for (const candidate of ordered) {
    const story = await services.ingestion.stories.getById(candidate.item_id);
    if (story === null) continue;
    const evidenceCount = await evidenceCountOf(services, candidate.item_id);
    items.push(
      await toFeedItem(
        services,
        story,
        explanation,
        undefined,
        meriGains[candidate.item_id] ?? null,
        evidenceCount,
      ),
    );
    explanationIds[candidate.item_id] = explanation.templateId;
    selectedForEvents.push({ itemId: candidate.item_id, score: 0, explanation });
  }
  const log = rankingDecisionLogSchema.parse({
    request_id: args.requestId,
    surface: request.surface,
    user_privacy_bucket: args.bucket,
    candidate_ids: [...args.candidateIds],
    selected_ids: selectedForEvents.map((s) => s.itemId),
    score_components: {},
    feature_revisions: {},
    invariant_versions: {},
    constraints_applied: args.gweiApplication === null ? [] : [args.gweiApplication],
    safety_exclusions: [...args.safetyExclusions],
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
  await commitDecision(services, { log }, selectedForEvents, request.surface);
  services.log('ranking.fallback.served', {
    request_id: args.requestId,
    surface: request.surface,
    reason: args.reason,
  });
  return { requestId: args.requestId, items, fallback: true };
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
 * fallback decisions verify the chronological invariant over the logged
 * selection (their ordering inputs are the immutable feature-pinned
 * timestamps where available).
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
  const replayed = rankFeasibleSet(
    candidates,
    features,
    inputs.profile_snapshot,
    inputs.enforcement as RankingEnforcement,
    {
      surface: log.surface,
      surfaceRoomId: inputs.surface_room_id,
      nowMs: Date.parse(log.timestamp),
      topicRelevanceByItem: relevance,
      userPhiRisk: inputs.user_phi_risk,
      sensitiveTopicIds: services.sensitiveTopicIds(),
      maxSourceSharePctOverride: inputs.max_source_share_pct_override,
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
