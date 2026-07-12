// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PWAtt v1 component computation (WS-E.2.3a + WS-E.2.3b INTEGRATED): the live
// pipeline stage that turns a window's deduplicated actor summaries into the
// v1 ActiveAttention and ConstructiveParticipation components using
//
//   • PER-USER saturation — each actor's Nth contribution of a type passes
//     through a diminishing-returns curve before weighting, so volume from one
//     user saturates for that user only (WS-E.2.3a "per-user/item/window");
//   • the CONTRIBUTION-TYPE HIERARCHY (WS-E.2.3b) — correction >
//     explanation > low_info_reply=0 —
//     applied at the accusing type's own weight for the source-free downweight;
//   • PER-DIMENSION saturation with the 50% dominance cap (WS-E.2.3a) — item
//     totals compose through `applySaturation`, so no single dimension can
//     exceed half the component budget regardless of input volume.
//
// Pure and total: same window input + config ⇒ same components (SPEC §30.6).
// Every parameter here is data (validated, tunable via the pwatt_config store).
import type { EventContributionType } from '@licio/shared';
import { DWELL_BUCKET_WEIGHTS, REPLY_DEPTH_BUCKET_WEIGHTS } from './active-attention.js';
import { RETURN_BUCKET_WEIGHTS } from './participation.js';
import {
  applySaturation,
  type SaturationCurve,
  type SaturationDimension,
  saturate,
  validateCurve,
  validateSaturationDimensions,
} from './saturation.js';
import {
  type ActorItemSummary,
  actorTrustFactor,
  clamp01,
  type ItemAntiSignals,
  toNonNegative,
} from './types.js';
import { assertV1HierarchyOrder, V1_CONTRIBUTION_WEIGHTS } from './v1.js';

/**
 * Anti-signal attenuation of the SERVED v1 components (WS-E.2.2 → WS-I). PWAtt
 * v1's own coordinated-burst / harassment-cascade detection is intrinsic to the
 * (already-lifted, §30.5) v1 stage — NOT a promotion-gated WS-H invariant — so
 * its dampening must bind the `active_attention` / `participation` the ranking
 * feature store actually reads, or detection is cosmetic. A detected burst
 * scales the components down in proportion to its confidence (up to
 * `coordinatedBurstMax`); a harassment cascade applies a fixed stronger factor.
 * Both factors compose multiplicatively, so an item carrying both signals is
 * attenuated the most. This is a positive-signal ATTENUATION (never a penalty
 * on the §5.4 penalty side), so it needs no WS-H promotion — it withholds trust
 * from an inauthentic window's attention rather than sanctioning the item.
 */
export interface AntiSignalAttenuationConfig {
  /** Max fraction of the components a full-confidence coordinated burst removes
   *  (0 = no effect, 1 = a full-confidence burst zeroes the window). */
  coordinatedBurstMax: number;
  /** Multiplier (< 1) applied to the components when a harassment cascade is
   *  detected for the window (0 = zero the window, 1 = no effect). */
  harassmentCascade: number;
}

export const DEFAULT_ANTI_SIGNAL_ATTENUATION: AntiSignalAttenuationConfig = {
  coordinatedBurstMax: 0.5,
  harassmentCascade: 0.3,
};

/** Validate the attenuation config; both factors must be in [0, 1]. */
export function validateAntiSignalAttenuation(config: AntiSignalAttenuationConfig): void {
  for (const [name, value] of [
    ['coordinatedBurstMax', config.coordinatedBurstMax],
    ['harassmentCascade', config.harassmentCascade],
  ] as const) {
    if (!(value >= 0 && value <= 1)) throw new Error(`${name} must be in [0, 1]`);
  }
}

export interface AntiSignalAttenuationResult {
  /** The multiplicative factor applied to each component, in [0, 1]. */
  factor: number;
  /** Ledger/audit annotations naming which anti-signal(s) attenuated. */
  annotations: string[];
}

/**
 * The multiplicative attenuation factor for a window's anti-signals. Pure and
 * total: no anti-signal ⇒ factor 1 (identity). Monotone in confidence — a
 * higher-confidence burst never raises the factor.
 */
export function antiSignalAttenuation(
  antiSignals: ItemAntiSignals | undefined,
  config: AntiSignalAttenuationConfig = DEFAULT_ANTI_SIGNAL_ATTENUATION,
): AntiSignalAttenuationResult {
  let factor = 1;
  const annotations: string[] = [];
  if (antiSignals?.coordinatedBurst !== undefined) {
    const confidence = clamp01(antiSignals.coordinatedBurst.confidence);
    factor *= 1 - config.coordinatedBurstMax * confidence;
    annotations.push('coordinated_burst_attenuated');
  }
  if (antiSignals?.harassmentCascade === true) {
    factor *= config.harassmentCascade;
    annotations.push('harassment_cascade_attenuated');
  }
  return { factor: clamp01(factor), annotations };
}

export interface PwattV1ComponentsConfig {
  /** The WS-E.2.3b hierarchy weights, each in [0, 1]; low_info_reply = 0. */
  contributionWeights: Readonly<Record<EventContributionType, number>>;
  /** Per-user diminishing-returns curve over each contribution type's count. */
  contributionCurve: SaturationCurve;
  /** Item-level ActiveAttention dimensions (weights sum 100, each <= 50). */
  attentionDimensions: Readonly<
    Record<'dwell' | 'source' | 'context' | 'traversal', SaturationDimension>
  >;
  /** Item-level Participation dimensions (weights sum 100, each <= 50). */
  participationDimensions: Readonly<
    Record<'returns' | 'saves' | 'contributions', SaturationDimension>
  >;
  /** Fraction of its type weight an uncited accusation keeps (WS-E.2.2b). */
  accusationDownweight: number;
  /**
   * WS-T sourced-comment bonus in [0, 1]: the extra weight a FULLY-sourced type
   * earns over an unsourced one, applied to the SATURATED per-type value (so the
   * concave curve + the ≤50% dimension cap bound it — a link-spam cannot run
   * away).  0 disables it.  An evidence signal, not applause.
   */
  citationBonus: number;
  /** Window contribution count beyond which rapid-repetition dampening applies. */
  rapidThreshold: number;
  /** Multiplier (< 1) applied to a rapid actor's contribution score (§5.3). */
  rapidDampening: number;
  /** Attenuation of the SERVED components when the window's anti-signals fire. */
  antiSignalAttenuation: AntiSignalAttenuationConfig;
}

const LOG_CURVE_DEFAULT: SaturationCurve = { kind: 'logarithmic', scale: 4, saturationPoint: 25 };

export const DEFAULT_PWATT_V1_COMPONENTS_CONFIG: PwattV1ComponentsConfig = {
  contributionWeights: V1_CONTRIBUTION_WEIGHTS,
  contributionCurve: { kind: 'logarithmic', scale: 1, saturationPoint: 6 },
  attentionDimensions: {
    dwell: { weightPct: 40, curve: LOG_CURVE_DEFAULT },
    source: { weightPct: 25, curve: LOG_CURVE_DEFAULT },
    context: { weightPct: 20, curve: LOG_CURVE_DEFAULT },
    traversal: { weightPct: 15, curve: LOG_CURVE_DEFAULT },
  },
  // The `saves` dimension carries the §5.3 "Save for later" LOW rank weight now
  // that the privacy-respecting `content.saved` signal flows (the save rides the
  // attention privacy pipeline; the saved collection stays client-local, §19.2).
  participationDimensions: {
    returns: { weightPct: 40, curve: LOG_CURVE_DEFAULT },
    saves: { weightPct: 10, curve: LOG_CURVE_DEFAULT },
    contributions: { weightPct: 50, curve: LOG_CURVE_DEFAULT },
  },
  accusationDownweight: 0.25,
  // A fully-sourced contribution earns +35% over an unsourced one, on the
  // saturated per-type value (reviewed default; fail-closed tunable).
  citationBonus: 0.35,
  rapidThreshold: 5,
  rapidDampening: 0.3,
  antiSignalAttenuation: DEFAULT_ANTI_SIGNAL_ATTENUATION,
};

/** Config-time rejection (WS-E.2.3a/b): every violation named. */
export function validatePwattV1ComponentsConfig(config: PwattV1ComponentsConfig): void {
  assertV1HierarchyOrder(config.contributionWeights);
  for (const [type, weight] of Object.entries(config.contributionWeights)) {
    if (!(weight >= 0 && weight <= 1)) {
      throw new Error(`contribution weight ${type} must be in [0, 1]`);
    }
  }
  validateCurve(config.contributionCurve);
  validateSaturationDimensions(config.attentionDimensions);
  validateSaturationDimensions(config.participationDimensions);
  for (const [name, factor] of [
    ['accusationDownweight', config.accusationDownweight],
    ['citationBonus', config.citationBonus],
    ['rapidDampening', config.rapidDampening],
  ] as const) {
    if (!(factor >= 0 && factor <= 1)) throw new Error(`${name} must be in [0, 1]`);
  }
  if (!(config.rapidThreshold >= 1)) throw new Error('rapidThreshold must be >= 1');
  validateAntiSignalAttenuation(config.antiSignalAttenuation);
}

export interface ActorV1ContributionResult {
  /** The actor's bounded [0, 1] hierarchy-weighted, saturated contribution. */
  value: number;
  annotations: string[];
}

/**
 * One actor's v1 contribution score: per-type counts pass through the
 * per-user diminishing curve at an EFFECTIVE count where uncited accusations
 * keep only `accusationDownweight` of an instance, then weight by the
 * hierarchy and cap at 1 (the per-user/item/window cap). Monotone: adding any
 * contribution never lowers the score; adding a citation to an accusation
 * raises it (the transparency remedy, WS-E.2.2b).
 */
export function actorV1Contribution(
  actor: Pick<
    ActorItemSummary,
    'contributions' | 'uncitedAccusationsByType' | 'citedContributionsByType'
  >,
  config: PwattV1ComponentsConfig = DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
): ActorV1ContributionResult {
  const annotations: string[] = [];
  let weighted = 0;
  let totalContributions = 0;
  let uncitedTotal = 0;
  let citedTotal = 0;
  for (const [type, count] of Object.entries(actor.contributions) as Array<
    [EventContributionType, number | undefined]
  >) {
    const n = toNonNegative(count ?? 0);
    totalContributions += n;
    const typeWeight = config.contributionWeights[type] ?? 0;
    if (typeWeight === 0) continue;
    const uncited = Math.min(toNonNegative(actor.uncitedAccusationsByType[type] ?? 0), n);
    uncitedTotal += uncited;
    const effectiveCount = n - uncited + config.accusationDownweight * uncited;
    const base = saturate(effectiveCount, config.contributionCurve);
    // WS-T — a sourced contribution earns a bonus on the SATURATED per-type value
    // (the structural inverse of the uncited-accusation downweight): the fraction
    // of this type that carries a source scales a `(1 + citationBonus)` multiplier.
    const cited = Math.min(toNonNegative(actor.citedContributionsByType[type] ?? 0), n);
    citedTotal += cited;
    const citedFraction = n > 0 ? cited / n : 0;
    weighted += typeWeight * base * (1 + config.citationBonus * citedFraction);
  }
  if (uncitedTotal > 0) annotations.push('source_free_accusation_downweight');
  if (citedTotal > 0) annotations.push('sourced_contribution_weighted');
  let value = clamp01(weighted);
  if (totalContributions > config.rapidThreshold) {
    value *= config.rapidDampening;
    annotations.push('rapid_repetition_dampened');
  }
  return { value, annotations };
}

export interface ComputedV1Components {
  /** ActiveAttention component in [0, 1] — SERVED (anti-signal attenuated). */
  activeAttention: number;
  /** ConstructiveParticipation component in [0, 1] — SERVED (attenuated). */
  participation: number;
  /** ActiveAttention BEFORE anti-signal attenuation (audit/ledger). */
  rawActiveAttention: number;
  /** ConstructiveParticipation BEFORE anti-signal attenuation (audit/ledger). */
  rawParticipation: number;
  /** The anti-signal attenuation factor applied to both components (1 = none). */
  antiSignalFactor: number;
  /** Per-dimension contributions (each <= its <=50% share — the cap proof). */
  attentionDimensions: Record<string, number>;
  participationDimensions: Record<string, number>;
  /** Per-actor v1 contribution annotations, for ledger/audit parity with v0. */
  actorAnnotations: Map<string, string[]>;
  /** Item-level anti-signal annotations (which detections attenuated). */
  antiSignalAnnotations: string[];
}

/**
 * Compute the v1 components for one item/window from the deduplicated actor
 * summaries. Item dimensions are saturating sums of bounded per-actor values:
 *
 *   dwell    = Σ_u dwellWeight(bucket_u)            (each <= 1)
 *   source   = Σ_u [meaningful source open]          (0/1; bounce-only = 0)
 *   context  = Σ_u [context open]                    (0/1)
 *   traversal= Σ_u replyDepthWeight(bucket_u)        (§5.3 thread traversal)
 *   returns  = Σ_u returnWeight(bucket_u)            (diminishing buckets)
 *   saves    = Σ_u [saved]                           (0/1; low 10% budget)
 *   contribs = Σ_u actorV1Contribution(u)            (hierarchy + curve, <= 1)
 *
 * then pass through `applySaturation`, so each dimension is capped at its
 * configured share (<= 50%) of the component budget regardless of volume.
 */
export function computePwattV1Components(
  actors: readonly ActorItemSummary[],
  config: PwattV1ComponentsConfig = DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
  antiSignals?: ItemAntiSignals,
): ComputedV1Components {
  let dwell = 0;
  let source = 0;
  let context = 0;
  let traversal = 0;
  let returns = 0;
  let saves = 0;
  let contributions = 0;
  const actorAnnotations = new Map<string, string[]>();
  for (const actor of actors) {
    // Account-age trust (WS-O.4.5) scales this actor's whole contribution: a
    // fresh/throwaway account adds less to every dimension than an aged one
    // (anonymity carries full trust — the coarse privacy bucket resolves to 1).
    const trust = actorTrustFactor(actor);
    dwell += trust * DWELL_BUCKET_WEIGHTS[actor.dwellBucket];
    if (actor.sourceOpened && !actor.sourceBounceOnly) source += trust;
    if (actor.contextOpened) context += trust;
    traversal += trust * REPLY_DEPTH_BUCKET_WEIGHTS[actor.replyDepthBucket ?? 'none'];
    returns += trust * RETURN_BUCKET_WEIGHTS[actor.returnVisitBucket];
    if (toNonNegative(actor.savedForLater) > 0) saves += trust;
    const contribution = actorV1Contribution(actor, config);
    contributions += trust * contribution.value;
    if (contribution.annotations.length > 0) {
      actorAnnotations.set(actor.actor, contribution.annotations);
    }
  }
  const attention = applySaturation(
    { dwell, source, context, traversal },
    config.attentionDimensions,
  );
  const participation = applySaturation(
    { returns, saves, contributions },
    config.participationDimensions,
  );
  // Bind the window's own anti-signals to the SERVED components (WS-E.2.2 →
  // WS-I): a coordinated burst / harassment cascade withholds trust from an
  // inauthentic window's attention so detection is consequential for ranking,
  // not merely logged. The raw components are retained for ledger/audit.
  const attenuation = antiSignalAttenuation(antiSignals, config.antiSignalAttenuation);
  return {
    activeAttention: clamp01(attention.total * attenuation.factor),
    participation: clamp01(participation.total * attenuation.factor),
    rawActiveAttention: attention.total,
    rawParticipation: participation.total,
    antiSignalFactor: attenuation.factor,
    attentionDimensions: attention.perDimension,
    participationDimensions: participation.perDimension,
    actorAnnotations,
    antiSignalAnnotations: attenuation.annotations,
  };
}
