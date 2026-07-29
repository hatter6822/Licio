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
// The constraint set `[cohort_parity, holonomy_limits]` is enforced by
// `gweiDeploymentGate` (profile-level) and PHI diversification respectively —
// hard limits, never traded against score.

import { applyBalancing, type BalancingInput } from './diversify/balancing.js';
import { applyMatroidDedup, type DedupInput } from './diversify/dedup.js';
import { type Candidate, mergeCandidates, parseTimestampOrZero } from './schemas/candidate.js';
import type { ConstraintApplication } from './schemas/decision-log.js';
import { FEATURE_SCHEMA_VERSION, type FeatureVector } from './schemas/feature-vector.js';
import type { RankingProfileConfig } from './schemas/profile.js';
import { type ConstraintFlag, type ScoredItem, scoredItemSchema } from './schemas/scored-item.js';
import { computeBaseline, freshnessFromAge } from './scoring/baseline.js';
import {
  type ConstraintEnforcement,
  evaluateItemConstraints,
  phiDiversification,
} from './scoring/constraints.js';
import {
  computePenalties,
  disputeOrderingSink,
  type PenaltyEnforcement,
  validationBoostTerm,
} from './scoring/penalties.js';
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
 * Whether an item is sensitive: it carries a non-`none` content sensitivity
 * label, or one of its topics is in the (forward-compat) sensitive-topic set.
 * The single source of truth for per-item AND request-level PHI sensitivity so
 * the two never drift.
 */
function isSensitiveItem(features: FeatureVector, sensitiveTopicIds: ReadonlySet<string>): boolean {
  return (
    (features.sensitivity_labels?.some((label) => label !== 'none') ?? false) ||
    features.topic_ids.some((topic) => sensitiveTopicIds.has(topic))
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
): ScoredItem {
  // Topic/freshness inputs come from the FEATURE VECTOR (the revision the
  // decision log pins), never the live candidate — serving and replay see
  // byte-identical inputs (WS-I.2.5b).
  // Per-item sensitivity is content-LABEL-driven (the story's non-`none`
  // sensitivity labels — per-item topics are catalog UUIDs, not slugs, so a
  // topic match against a slug set never fires per item). The topic-id set
  // stays a forward-compat hook for a deployment that marks specific catalog
  // topics sensitive. Either selection realizes §11.5 sensitive-topic handling
  // via the conservative (evergreen) decay curve here plus the request-level PHI
  // threshold tightening (phi_sensitive_factor) in phiDiversification — there is
  // no per-item sensitive-content penalty; the sensitiveTopic flag is threaded to
  // computePenalties only for signature stability / future per-item terms.
  const sensitiveTopic = isSensitiveItem(features, context.sensitiveTopicIds);
  const ageMs = Math.max(0, context.nowMs - Date.parse(features.created_at));
  const curve = sensitiveTopic ? profile.decay_curves.evergreen : profile.decay_curves.breaking;
  const relevance = context.topicRelevanceByItem?.get(candidate.item_id);
  // The §11.5 conservative curve BINDS on sensitive content.
  //
  // `features.freshness_decay ?? freshnessFromAge(…, curve)` made the curve an
  // ALTERNATIVE to the stored WS-F score rather than a bound on it — so for
  // every story WS-F had scored, which is every story with a freshness row, the
  // curve selection above was dead and sensitive content decayed exactly like
  // breaking news.  The comment two paragraphs up said the opposite.
  //
  // A sensitive item is now capped by the conservative envelope AND by WS-F's
  // own cadence-relative assessment, so the cap can only ever LOWER a sensitive
  // item's freshness — never raise one, which a bare curve substitution would
  // do for a young item in a fast-cadence topic.  Non-sensitive scoring is
  // unchanged, including the breaking curve's role as the fallback when WS-F
  // has not scored a story yet: this closes a hole in the sensitive-content
  // guard, and is deliberately not a re-tune of the whole feed.
  const storedFreshness = features.freshness_decay;
  const freshnessDecay = sensitiveTopic
    ? Math.min(storedFreshness ?? 1, freshnessFromAge(ageMs, curve.half_life_hours))
    : (storedFreshness ?? freshnessFromAge(ageMs, curve.half_life_hours));
  const baseline = computeBaseline({
    freshnessDecay,
    sourceReliability: features.source_reliability,
    topicRelevance: relevance,
    personalizationEnabled: context.topicRelevanceByItem !== null,
    weights: profile.baseline_weights,
  });
  const positive = computePositiveScore(features, profile, baseline);
  const penalties = computePenalties(features, profile, enforcement, { sensitiveTopic });
  // WS-T — a `corrected` story sinks BELOW every non-disputed story: the sink is
  // subtracted AFTER the penalty subtraction, so strong baseline /
  // participation can never rescue it (SPEC §5.4; the comment-section analogue).
  const rawScore = positive.components.positive - penalties.total_applied;
  // WS-T — the `validated` boost: a modest lift for content challenged and proven
  // accurate, recorded as a term so the decision log reconciles the score and the
  // audit surfaces the signal. Applied symmetric with the sink; a story is
  // never both `corrected` and `validated`.
  const validation = validationBoostTerm(features, profile);
  return scoredItemSchema.parse({
    item_id: candidate.item_id,
    pwatt_score: rawScore - disputeOrderingSink(features, profile) + validation.applied,
    score_components: positive.components,
    penalty_components: penalties,
    validation_boost: validation,
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
      parseTimestampOrZero(b.features.created_at) - parseTimestampOrZero(a.features.created_at) ||
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

  // Evaluate constraints ONCE per item; infeasible items (e.g. MFCI-severe
  // cross-community) leave the set BEFORE the PHI decision — so a sensitive item
  // that is filtered out and never served cannot make a neutral page a
  // "sensitive journey".
  const feasibleItems: Array<{
    candidate: Candidate;
    features: FeatureVector;
    flags: ConstraintFlag[];
  }> = [];
  for (const candidate of feasible) {
    const features =
      featuresById.get(candidate.item_id) ?? emptyFeatureVector(candidate, context.nowMs);
    const evaluation = evaluateItemConstraints(features, profile, enforcement, {
      surface: context.surface,
      crossCommunity: isCrossCommunity(candidate, context),
    });
    applications.push(...evaluation.applications);
    if (!evaluation.feasible) continue;
    feasibleItems.push({ candidate, features, flags: evaluation.flags });
  }

  // PHI per-user diversification (the `holonomy_limits` constraint): a request is
  // a sensitive journey only if it actually SERVES a sensitive item, so the
  // stricter (phi_sensitive_factor-scaled) threshold is derived from the FEASIBLE
  // set — the same sensitivity rule scoreItem applies per item.  The phi
  // application is kept first in the log (unshift) to preserve replay order.
  const sensitiveContext = feasibleItems.some(({ features }) =>
    isSensitiveItem(features, context.sensitiveTopicIds),
  );
  const phi = phiDiversification(context.userPhiRisk, profile, enforcement, sensitiveContext);
  if (phi.application !== null) applications.unshift(phi.application);

  const scored: Array<{ item: ScoredItem; candidate: Candidate; features: FeatureVector }> =
    feasibleItems.map(({ candidate, features, flags }) => ({
      item: scoreItem(
        candidate,
        features,
        profile,
        enforcement,
        context,
        phi.diversify ? [...flags, 'phi_diversify'] : flags,
      ),
      candidate,
      features,
    }));

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
    // Cold-start sensitivity: inherit the candidate's labels so the §11.5 guard
    // in scoreItem fires on an unrevisioned item's first serve.
    ...(candidate.sensitivity_labels !== undefined
      ? { sensitivity_labels: [...candidate.sensitivity_labels] }
      : {}),
    source_id: candidate.source_id,
    created_at: candidate.freshness_timestamp,
    feature_version: FEATURE_SCHEMA_VERSION,
    revision: 0,
    invariant_versions: {},
    updated_at: now,
  };
}

/**
 * WS-I.4.1b — the safe fallback ordering: strictly chronological (newest
 * first; deterministic id tie-break), the same semantics as the WS-E
 * freshness ranking. No score, no personalization, no financial anything.
 * ALSO the `new` user sort mode (SPEC §11.6): most recent first.
 */
export function chronologicalOrder(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      parseTimestampOrZero(b.freshness_timestamp) - parseTimestampOrZero(a.freshness_timestamp) ||
      a.item_id.localeCompare(b.item_id),
  );
}

/**
 * The user-selected metric sort orders (SPEC §11.6 feed modes `rising` /
 * `sources` / `debates`): a COMPLETE deterministic ordering of the feasible
 * set by a per-item content-derived metric — PWAtt window-over-window
 * velocity, sourced-comment count, or the WS-T debates tally — descending,
 * with the chronological tie-break (freshness desc, then item id). An item
 * the metric map does not cover sorts as 0 (honest absence: no history / no
 * signal ties with flat, ahead of falling for a signed metric). Like
 * `chronologicalOrder` this is an explicit reader choice, never a
 * popularity/applause count — the metrics are attention-, citation-, and
 * adjudication-derived by construction.
 */
export function metricOrder(
  candidates: readonly Candidate[],
  metricByItem: ReadonlyMap<string, number>,
): Candidate[] {
  const metric = (candidate: Candidate): number => {
    const value = metricByItem.get(candidate.item_id);
    return value !== undefined && Number.isFinite(value) ? value : 0;
  };
  return [...candidates].sort(
    (a, b) =>
      metric(b) - metric(a) ||
      parseTimestampOrZero(b.freshness_timestamp) - parseTimestampOrZero(a.freshness_timestamp) ||
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
