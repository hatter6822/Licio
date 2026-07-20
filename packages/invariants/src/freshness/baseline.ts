// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Freshness baseline (WS-F.1.4g, SPEC §14.4/§13.2) — the versioned,
// financial-input-free feature ranking uses for cold-start mitigation
// (consumed by WS-I.2.3d; preserves the §13.2 minimum quota of fresh
// content).
//
// Model. Freshness is a convex combination of exponential decays:
//
//   score = w_submit · exp(−A_submit / τ_topic)
//         + w_update · exp(−A_update / τ_update)
//         + w_event  · exp(−A_event  / τ_event)
//
// where A_* are non-negative ages (since submission, since the last material
// update, since the underlying event when known) and τ_topic scales with the
// topic's typical inter-arrival time, clamped to [τ_min, τ_max] — so "fresh"
// is judged relative to the topic's normal cadence (a slow topic keeps
// stories fresh longer; a fast topic decays quickly), exactly the WS-F.1.4g
// requirement. When the event time is unknown its term redistributes onto
// the submission term (the weights always sum to 1).
//
// Mathematical properties (property-tested):
//   • score ∈ (0, 1]: each exp term ∈ (0, 1], weights sum to 1.
//   • Monotone non-increasing in every age (exact arithmetic: strictly
//     decreasing, d/dA e^(−A/τ) < 0). In IEEE-754 the strict form holds
//     while the changing term is representable against the sum; once a term
//     decays below the ulp of the score (ages ≫ 25τ — months past any
//     ranking horizon) older inputs compare EQUAL, never greater. The tests
//     pin both: weak monotonicity globally, strict in the fresh regime.
//   • Topic normalization: same ages, slower topic cadence ⇒ τ_topic larger
//     ⇒ submission term larger ⇒ score never smaller.
//   • Deterministic and total: pure function of its arguments; no clock, no
//     I/O, and the input type carries no financial field (the WS-F.2.5b
//     denylist also covers the persisted feature record).

/** Bump when the formula or defaults change (reproducibility, §21.4). */
export const FRESHNESS_FEATURE_VERSION = 1;

export interface FreshnessConfig {
  /** Weight of the time-since-submission term. */
  submitWeight: number;
  /** Weight of the time-since-last-material-update term. */
  updateWeight: number;
  /** Weight of the event-recency term (folded into submit when unknown). */
  eventWeight: number;
  /** τ_topic = clamp(topicMedianInterArrivalMs × topicTauFactor, min, max). */
  topicTauFactor: number;
  topicTauMinMs: number;
  topicTauMaxMs: number;
  /** Decay constant for the material-update term. */
  updateTauMs: number;
  /** Decay constant for the event-recency term. */
  eventTauMs: number;
}

export const DEFAULT_FRESHNESS_CONFIG: FreshnessConfig = {
  submitWeight: 0.5,
  updateWeight: 0.3,
  eventWeight: 0.2,
  topicTauFactor: 2,
  topicTauMinMs: 6 * 3_600_000, // 6 h — even the fastest topic decays no faster
  topicTauMaxMs: 14 * 24 * 3_600_000, // 14 d — even a dormant topic decays eventually
  updateTauMs: 24 * 3_600_000, // 1 d
  eventTauMs: 48 * 3_600_000, // 2 d
};

export interface FreshnessInput {
  /** Evaluation time (ms epoch). */
  nowMs: number;
  /** Story submission time (ms epoch). */
  submittedAtMs: number;
  /** Last material update (new contribution/evidence/claim); defaults to submission. */
  lastMaterialUpdateMs?: number | undefined;
  /** Recency of the underlying EVENT (content property, §19.1), when known. */
  eventTimeMs?: number | undefined;
  /**
   * The topic's typical fresh-content cadence: median inter-arrival time of
   * recent submissions in the story's topics (ms). Null/absent ⇒ the topic
   * baseline is unknown and τ_topic falls back to the geometric midpoint of
   * the clamp range (graceful degradation, WS-F.1.4g soft dependency).
   */
  topicMedianInterArrivalMs?: number | null | undefined;
}

/** Validate a freshness config; returns an error string or null. */
export function validateFreshnessConfig(config: FreshnessConfig): string | null {
  const weights = [config.submitWeight, config.updateWeight, config.eventWeight];
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    return 'freshness weights must be non-negative finite numbers';
  }
  const sum = config.submitWeight + config.updateWeight + config.eventWeight;
  if (Math.abs(sum - 1) > 1e-9) return `freshness weights must sum to 1 (got ${sum})`;
  if (!(config.topicTauFactor > 0)) return 'topicTauFactor must be > 0';
  if (!(config.topicTauMinMs > 0) || !(config.topicTauMaxMs >= config.topicTauMinMs)) {
    return 'topic tau clamp must satisfy 0 < min <= max';
  }
  if (!(config.updateTauMs > 0) || !(config.eventTauMs > 0)) {
    return 'update/event tau must be > 0';
  }
  return null;
}

/** τ_topic for a (possibly unknown) topic cadence, clamped to the config range. */
export function topicTauMs(
  topicMedianInterArrivalMs: number | null | undefined,
  config: FreshnessConfig = DEFAULT_FRESHNESS_CONFIG,
): number {
  if (
    topicMedianInterArrivalMs === null ||
    topicMedianInterArrivalMs === undefined ||
    !Number.isFinite(topicMedianInterArrivalMs) ||
    topicMedianInterArrivalMs <= 0
  ) {
    // Geometric midpoint of the clamp range: neutral when cadence is unknown.
    return Math.sqrt(config.topicTauMinMs * config.topicTauMaxMs);
  }
  const scaled = topicMedianInterArrivalMs * config.topicTauFactor;
  return Math.min(config.topicTauMaxMs, Math.max(config.topicTauMinMs, scaled));
}

/**
 * Clamp an age to ≥ 0 (clock skew between writers must never raise a score).
 * Total: a non-finite age (NaN/±Infinity timestamp) decays to +Infinity so
 * its exp term is exp(−∞)=0 (least fresh) rather than producing a NaN score.
 */
function ageMs(nowMs: number, thenMs: number): number {
  const d = nowMs - thenMs;
  return Number.isFinite(d) ? Math.max(0, d) : Number.POSITIVE_INFINITY;
}

/**
 * The freshness score in (0, 1]. See the module header for the formula and
 * properties.
 */
export function computeFreshnessScore(
  input: FreshnessInput,
  config: FreshnessConfig = DEFAULT_FRESHNESS_CONFIG,
): number {
  // Enforce the (0, 1] precondition at the pure-function trust boundary. The
  // default hot path (the per-story sweep always passes the default) pays only
  // one reference comparison; any non-default config is validated and fails
  // closed, so the documented bound is structural, not convention-dependent.
  if (config !== DEFAULT_FRESHNESS_CONFIG) {
    const err = validateFreshnessConfig(config);
    if (err) throw new Error(`invalid freshness config: ${err}`);
  }

  const tauTopic = topicTauMs(input.topicMedianInterArrivalMs, config);
  const submitAge = ageMs(input.nowMs, input.submittedAtMs);
  const updateAge = ageMs(input.nowMs, input.lastMaterialUpdateMs ?? input.submittedAtMs);

  const submitTerm = Math.exp(-submitAge / tauTopic);
  const updateTerm = Math.exp(-updateAge / config.updateTauMs);

  if (input.eventTimeMs === undefined) {
    // Event recency unknown: its weight redistributes onto the submission
    // term so the weights still sum to 1 and unknown-event stories are not
    // penalized relative to known-event ones.
    const score =
      (config.submitWeight + config.eventWeight) * submitTerm + config.updateWeight * updateTerm;
    return Number.isFinite(score) ? score : 0;
  }
  const eventAge = ageMs(input.nowMs, input.eventTimeMs);
  const eventTerm = Math.exp(-eventAge / config.eventTauMs);
  const score =
    config.submitWeight * submitTerm +
    config.updateWeight * updateTerm +
    config.eventWeight * eventTerm;
  return Number.isFinite(score) ? score : 0;
}

/** The persisted feature record shape (WS-F.1.4g acceptance: versioned). */
export interface FreshnessBaselineRecord {
  storyId: string;
  freshnessScore: number;
  /** The topic-baseline input used (ms), or null when unknown — reproducibility. */
  topicBaselineMs: number | null;
  computedAt: string;
  featureVersion: number;
}
