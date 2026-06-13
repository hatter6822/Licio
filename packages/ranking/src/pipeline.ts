// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3e / WS-I.2.4 — the deterministic constrained-optimization core
// (SPEC §13.4 `constrained_optimize` + `diversify_with_matroid_rank`). ONE
// pure function consumed by BOTH the serving path and replay (WS-I.2.5b):
// given the feasible set, the per-item feature vectors, the ranking profile,
// and the promotion-enforcement flags, it produces the ordered, diversified
// selection with full score/penalty breakdowns and every constraint
// application. No clock, no randomness, no I/O — identical inputs produce
// byte-identical output (the M3 reproducibility gate).
//
// Objective realization: items are ordered by the scalarized objective
// `pwatt_score` (which already embeds exposure_independence, evidence
// completeness, and relevance through the §5.5 convex weights and the
// baseline), with deterministic tie-breaks on (freshness desc, item id).
// The constraint set `[cohort_parity, context_requirements, holonomy_limits]`
// is enforced by `gweiDeploymentGate` (profile-level), SCOI gating, and PHI
// diversification respectively — hard limits, never traded against score.

import { applyBalancing, type BalancingInput } from './diversify/balancing.js';
import { applyMatroidDedup, type DedupInput } from './diversify/dedup.js';
import { type Candidate, mergeCandidates } from './schemas/candidate.js';
import type { ConstraintApplication } from './schemas/decision-log.js';
import type { FeatureVector } from './schemas/feature-vector.js';
import type { RankingProfileConfig } from './schemas/profile.js';
import { type ConstraintFlag, type ScoredItem, scoredItemSchema } from './schemas/scored-item.js';
import { computeBaseline, freshnessFromAge } from './scoring/baseline.js';
import {
  type ConstraintEnforcement,
  evaluateItemConstraints,
  phiDiversification,
} from './scoring/constraints.js';
import { computePenalties, type PenaltyEnforcement } from './scoring/penalties.js';
import { computePositiveScore } from './scoring/pwatt.js';

export { mergeCandidates };

/** Promotion-enforcement flags for every effect-bearing invariant. */
export interface RankingEnforcement extends PenaltyEnforcement, ConstraintEnforcement {}

/** Everything shadow — the fail-closed default until WS-H promotions land. */
export const SHADOW_RANKING_ENFORCEMENT: RankingEnforcement = {
  mfci: false,
  phi: false,
  hodge: false,
  meri: false,
  tropical: false,
  scoi: false,
  gwei: false,
};

export interface RankingRequestContext {
  surface: 'front_page' | 'room' | 'topic';
  /** The room the surface belongs to (room feeds), else null. */
  surfaceRoomId: string | null;
  /** Evaluation time (ms since epoch) — passed in, never read from a clock. */
  nowMs: number;
  /**
   * Per-item topic relevance, PRE-RESOLVED by the caller from the requesting
   * user's own configured interests; null ⇒ personalization is OFF for this
   * request. Pre-resolving (rather than passing the preference list) keeps
   * the pipeline replayable from the decision log without persisting the
   * user's interest list (WS-I.2.5b + §22.4 privacy posture).
   */
  topicRelevanceByItem: ReadonlyMap<string, number> | null;
  /** Latest PHI risk for the REQUESTING user's session (null ⇒ none). */
  userPhiRisk: number | null;
  /** Topic ids configured as sensitive (stricter PHI thresholds). */
  sensitiveTopicIds: ReadonlySet<string>;
  /** Feed-mode balancing override (source-diverse mode); null ⇒ profile. */
  maxSourceSharePctOverride: number | null;
  /**
   * item id → lens id for WS-I.2.4b lens balancing (room surfaces; derived
   * from the thread's lens-tagged contributions). Null when the surface has
   * no lens dimension. Pinned in the decision log because lens assignments
   * affect the ordering (WS-I.2.5b).
   */
  lensByItem: ReadonlyMap<string, string> | null;
}

export interface RankedSelection {
  /** Ordered, diversified selection (≤ profile.page_size). */
  selected: ScoredItem[];
  /** Cluster id → item ids demoted to "more on this story" expansion. */
  expansions: Map<string, string[]>;
  /** Every constraint application, in evaluation order. */
  applications: ConstraintApplication[];
  /** item id → ordered position (0-based) for replay diffs. */
  positions: Map<string, number>;
  /** True when PHI diversification tightened balancing for this request. */
  phiDiversified: boolean;
}

/** Whether a candidate is cross-community relative to the request surface. */
function isCrossCommunity(candidate: Candidate, context: RankingRequestContext): boolean {
  return (
    context.surface !== 'room' ||
    (candidate.room_id !== null && candidate.room_id !== context.surfaceRoomId)
  );
}

/**
 * Score one feasible item given its (single) constraint evaluation. Exposed
 * for unit tests; the pipeline applies it to every feasible candidate.
 */
export function scoreItem(
  candidate: Candidate,
  features: FeatureVector,
  profile: RankingProfileConfig,
  enforcement: RankingEnforcement,
  context: RankingRequestContext,
  constraintFlags: readonly ConstraintFlag[],
  distributionMultiplier: number,
): ScoredItem {
  // Topic/freshness inputs come from the FEATURE VECTOR (the revision the
  // decision log pins), never the live candidate — serving and replay see
  // byte-identical inputs (WS-I.2.5b).
  const sensitiveTopic = features.topic_ids.some((topic) => context.sensitiveTopicIds.has(topic));
  const ageMs = Math.max(0, context.nowMs - Date.parse(features.created_at));
  const curve = sensitiveTopic ? profile.decay_curves.evergreen : profile.decay_curves.breaking;
  const relevance = context.topicRelevanceByItem?.get(candidate.item_id);
  const baseline = computeBaseline({
    freshnessDecay: features.freshness_decay ?? freshnessFromAge(ageMs, curve.half_life_hours),
    sourceReliability: features.source_reliability,
    topicRelevance: relevance,
    personalizationEnabled: context.topicRelevanceByItem !== null,
    weights: profile.baseline_weights,
  });
  const positive = computePositiveScore(features, profile, baseline);
  const penalties = computePenalties(features, profile, enforcement, { sensitiveTopic });
  return scoredItemSchema.parse({
    item_id: candidate.item_id,
    pwatt_score: (positive.components.positive - penalties.total_applied) * distributionMultiplier,
    score_components: positive.components,
    penalty_components: penalties,
    baseline,
    constraint_flags: [...constraintFlags],
  });
}

/** Internal: deterministic ordering of scored items (ties: feature-pinned
 *  freshness desc, then item id). */
function orderScored(
  scored: ReadonlyArray<{ item: ScoredItem; candidate: Candidate; features: FeatureVector }>,
): Array<{ item: ScoredItem; candidate: Candidate; features: FeatureVector }> {
  return [...scored].sort(
    (a, b) =>
      b.item.pwatt_score - a.item.pwatt_score ||
      Date.parse(b.features.created_at) - Date.parse(a.features.created_at) ||
      a.item.item_id.localeCompare(b.item.item_id),
  );
}

/**
 * The deterministic ranking core: feasible set → constraint evaluation →
 * scoring → ordering → matroid dedup → balanced page. Items the feature
 * store has not covered yet still rank (baseline-only, honest cold start).
 */
export function rankFeasibleSet(
  feasible: readonly Candidate[],
  featuresById: ReadonlyMap<string, FeatureVector>,
  profile: RankingProfileConfig,
  enforcement: RankingEnforcement,
  context: RankingRequestContext,
): RankedSelection {
  const applications: ConstraintApplication[] = [];

  // PHI per-user diversification (the `holonomy_limits` constraint).
  const phi = phiDiversification(context.userPhiRisk, profile, enforcement);
  if (phi.application !== null) applications.push(phi.application);

  // Evaluate constraints ONCE per item; infeasible items leave the set.
  const scored: Array<{ item: ScoredItem; candidate: Candidate; features: FeatureVector }> = [];
  for (const candidate of feasible) {
    const features =
      featuresById.get(candidate.item_id) ?? emptyFeatureVector(candidate, context.nowMs);
    const evaluation = evaluateItemConstraints(features, profile, enforcement, {
      surface: context.surface,
      crossCommunity: isCrossCommunity(candidate, context),
    });
    applications.push(...evaluation.applications);
    if (!evaluation.feasible) continue;
    const flags: ConstraintFlag[] = phi.diversify
      ? [...evaluation.flags, 'phi_diversify']
      : evaluation.flags;
    scored.push({
      item: scoreItem(
        candidate,
        features,
        profile,
        enforcement,
        context,
        flags,
        evaluation.distributionMultiplier,
      ),
      candidate,
      features,
    });
  }

  const ordered = orderScored(scored);

  // Matroid dedup (WS-I.2.4a): MERI duplicate clusters capped per page.
  const dedupInput: DedupInput[] = ordered.map(({ item, features }) => ({
    itemId: item.item_id,
    score: item.pwatt_score,
    clusterId: features.duplicate_cluster_id ?? null,
  }));
  const dedup = applyMatroidDedup(dedupInput, profile.constraints.meri_max_per_cluster);
  applications.push(...dedup.applications);
  const keptIds = new Set(dedup.kept.map((k) => k.itemId));
  const afterDedup = ordered.filter(({ item }) => keptIds.has(item.item_id));

  // Balancing (WS-I.2.4b): source/topic caps + lens representation. Inputs
  // are the FEATURE-pinned source/topic identities (replay determinism).
  const balanceInput: BalancingInput[] = afterDedup.map(({ item, features }) => ({
    itemId: item.item_id,
    score: item.pwatt_score,
    sourceId: features.source_id,
    topicIds: features.topic_ids,
    lensId: context.lensByItem?.get(item.item_id) ?? null,
  }));
  const balanced = applyBalancing(balanceInput, {
    pageSize: profile.page_size,
    maxSourceSharePct: context.maxSourceSharePctOverride ?? profile.balancing.max_source_share_pct,
    maxTopicSharePct: profile.balancing.max_topic_share_pct,
    minDistinctLenses: profile.balancing.min_distinct_lenses,
    phiTighten: phi.diversify,
  });
  applications.push(...balanced.applications);

  const byId = new Map(afterDedup.map(({ item }) => [item.item_id, item]));
  const selected = balanced.page
    .map((entry) => byId.get(entry.itemId))
    .filter((item): item is ScoredItem => item !== undefined);

  const expansions = new Map<string, string[]>();
  for (const [cluster, items] of dedup.expansions) {
    expansions.set(
      cluster,
      items.map((i) => i.itemId),
    );
  }
  const positions = new Map<string, number>();
  for (const [index, item] of selected.entries()) positions.set(item.item_id, index);

  return { selected, expansions, applications, positions, phiDiversified: phi.diversify };
}

/** An honest empty feature vector for a candidate the store has not covered
 *  yet (cold start): metadata only, every signal ABSENT. */
export function emptyFeatureVector(candidate: Candidate, nowMs: number): FeatureVector {
  const now = new Date(nowMs).toISOString();
  return {
    item_id: candidate.item_id,
    item_type: candidate.item_type,
    room_id: candidate.room_id,
    visibility: candidate.visibility,
    topic_ids: [...candidate.topic_ids],
    source_id: candidate.source_id,
    created_at: candidate.freshness_timestamp,
    feature_version: 1,
    revision: 0,
    invariant_versions: {},
    updated_at: now,
  };
}

/**
 * WS-I.4.1b — the safe fallback ordering: strictly chronological (newest
 * first; deterministic id tie-break), the same semantics as the WS-E
 * freshness ranking. No score, no personalization, no financial anything.
 */
export function chronologicalOrder(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      Date.parse(b.freshness_timestamp) - Date.parse(a.freshness_timestamp) ||
      a.item_id.localeCompare(b.item_id),
  );
}

const SCORE_EPSILON = 1e-9;

export interface ReplayDiffEntry {
  item_id: string;
  expected_position: number | null;
  actual_position: number | null;
  score_diff: number | null;
}

/**
 * WS-I.2.5b — structured replay comparison: expected (logged) vs actual
 * (replayed) selections. Empty diff ⇔ exact match (order and scores).
 */
export function diffRankings(
  expected: ReadonlyArray<{ itemId: string; score: number }>,
  actual: ReadonlyArray<{ itemId: string; score: number }>,
): ReplayDiffEntry[] {
  const diff: ReplayDiffEntry[] = [];
  const expectedPos = new Map(expected.map((e, i) => [e.itemId, { position: i, score: e.score }]));
  const actualPos = new Map(actual.map((a, i) => [a.itemId, { position: i, score: a.score }]));
  const allIds = [...new Set([...expectedPos.keys(), ...actualPos.keys()])].sort();
  for (const itemId of allIds) {
    const exp = expectedPos.get(itemId);
    const act = actualPos.get(itemId);
    if (exp === undefined || act === undefined) {
      diff.push({
        item_id: itemId,
        expected_position: exp?.position ?? null,
        actual_position: act?.position ?? null,
        score_diff: null,
      });
      continue;
    }
    const scoreDiff = act.score - exp.score;
    if (exp.position !== act.position || Math.abs(scoreDiff) > SCORE_EPSILON) {
      diff.push({
        item_id: itemId,
        expected_position: exp.position,
        actual_position: act.position,
        score_diff: scoreDiff,
      });
    }
  }
  return diff;
}
