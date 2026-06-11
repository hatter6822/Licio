// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PWAtt v1 component computation (WS-E.2.3a + WS-E.2.3b INTEGRATED): the live
// pipeline stage that turns a window's deduplicated actor summaries into the
// v1 ActiveAttention and ConstructiveParticipation components using
//
//   • PER-USER saturation — each actor's Nth contribution of a type passes
//     through a diminishing-returns curve before weighting, so volume from one
//     user saturates for that user only (WS-E.2.3a "per-user/item/window");
//   • the CONTRIBUTION-TYPE HIERARCHY (WS-E.2.3b) — evidence > correction >
//     synthesis > question > counterexample > explanation > low_info_reply=0 —
//     applied at the accusing type's own weight for the source-free downweight;
//   • PER-DIMENSION saturation with the 50% dominance cap (WS-E.2.3a) — item
//     totals compose through `applySaturation`, so no single dimension can
//     exceed half the component budget regardless of input volume.
//
// Pure and total: same window input + config ⇒ same components (SPEC §30.6).
// Every parameter here is data (validated, tunable via the pwatt_config store).
import type { EventContributionType } from '@licio/shared';
import { DWELL_BUCKET_WEIGHTS } from './active-attention.js';
import { RETURN_BUCKET_WEIGHTS } from './participation.js';
import {
  applySaturation,
  type SaturationCurve,
  type SaturationDimension,
  saturate,
  validateCurve,
  validateSaturationDimensions,
} from './saturation.js';
import { type ActorItemSummary, clamp01, toNonNegative } from './types.js';
import { assertV1HierarchyOrder, V1_CONTRIBUTION_WEIGHTS } from './v1.js';

export interface PwattV1ComponentsConfig {
  /** The WS-E.2.3b hierarchy weights, each in [0, 1]; low_info_reply/flag = 0. */
  contributionWeights: Readonly<Record<EventContributionType, number>>;
  /** Per-user diminishing-returns curve over each contribution type's count. */
  contributionCurve: SaturationCurve;
  /** Item-level ActiveAttention dimensions (weights sum 100, each <= 50). */
  attentionDimensions: Readonly<Record<'dwell' | 'source' | 'context', SaturationDimension>>;
  /** Item-level Participation dimensions (weights sum 100, each <= 50). */
  participationDimensions: Readonly<
    Record<'returns' | 'saves' | 'contributions', SaturationDimension>
  >;
  /** Fraction of its type weight an uncited accusation keeps (WS-E.2.2b). */
  accusationDownweight: number;
  /** Window contribution count beyond which rapid-repetition dampening applies. */
  rapidThreshold: number;
  /** Multiplier (< 1) applied to a rapid actor's contribution score (§5.3). */
  rapidDampening: number;
}

const LOG_CURVE_DEFAULT: SaturationCurve = { kind: 'logarithmic', scale: 4, saturationPoint: 25 };

export const DEFAULT_PWATT_V1_COMPONENTS_CONFIG: PwattV1ComponentsConfig = {
  contributionWeights: V1_CONTRIBUTION_WEIGHTS,
  contributionCurve: { kind: 'logarithmic', scale: 1, saturationPoint: 6 },
  attentionDimensions: {
    dwell: { weightPct: 50, curve: LOG_CURVE_DEFAULT },
    source: { weightPct: 30, curve: LOG_CURVE_DEFAULT },
    context: { weightPct: 20, curve: LOG_CURVE_DEFAULT },
  },
  participationDimensions: {
    returns: { weightPct: 40, curve: LOG_CURVE_DEFAULT },
    saves: { weightPct: 10, curve: LOG_CURVE_DEFAULT },
    contributions: { weightPct: 50, curve: LOG_CURVE_DEFAULT },
  },
  accusationDownweight: 0.25,
  rapidThreshold: 5,
  rapidDampening: 0.3,
};

/** Config-time rejection (WS-E.2.3a/b): every violation named. */
export function validatePwattV1ComponentsConfig(config: PwattV1ComponentsConfig): void {
  assertV1HierarchyOrder(config.contributionWeights);
  if (config.contributionWeights.flag !== 0) {
    throw new Error('flag must carry zero constructive weight');
  }
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
    ['rapidDampening', config.rapidDampening],
  ] as const) {
    if (!(factor >= 0 && factor <= 1)) throw new Error(`${name} must be in [0, 1]`);
  }
  if (!(config.rapidThreshold >= 1)) throw new Error('rapidThreshold must be >= 1');
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
  actor: Pick<ActorItemSummary, 'contributions' | 'uncitedAccusationsByType'>,
  config: PwattV1ComponentsConfig = DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
): ActorV1ContributionResult {
  const annotations: string[] = [];
  let weighted = 0;
  let totalContributions = 0;
  let uncitedTotal = 0;
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
    weighted += typeWeight * saturate(effectiveCount, config.contributionCurve);
  }
  if (uncitedTotal > 0) annotations.push('source_free_accusation_downweight');
  let value = clamp01(weighted);
  if (totalContributions > config.rapidThreshold) {
    value *= config.rapidDampening;
    annotations.push('rapid_repetition_dampened');
  }
  return { value, annotations };
}

export interface ComputedV1Components {
  /** ActiveAttention component in [0, 1]. */
  activeAttention: number;
  /** ConstructiveParticipation component in [0, 1]. */
  participation: number;
  /** Per-dimension contributions (each <= its <=50% share — the cap proof). */
  attentionDimensions: Record<string, number>;
  participationDimensions: Record<string, number>;
  /** Per-actor v1 contribution annotations, for ledger/audit parity with v0. */
  actorAnnotations: Map<string, string[]>;
}

/**
 * Compute the v1 components for one item/window from the deduplicated actor
 * summaries. Item dimensions are saturating sums of bounded per-actor values:
 *
 *   dwell    = Σ_u dwellWeight(bucket_u)            (each <= 1)
 *   source   = Σ_u [meaningful source open]          (0/1; bounce-only = 0)
 *   context  = Σ_u [context open]                    (0/1)
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
): ComputedV1Components {
  let dwell = 0;
  let source = 0;
  let context = 0;
  let returns = 0;
  let saves = 0;
  let contributions = 0;
  const actorAnnotations = new Map<string, string[]>();
  for (const actor of actors) {
    dwell += DWELL_BUCKET_WEIGHTS[actor.dwellBucket];
    if (actor.sourceOpened && !actor.sourceBounceOnly) source += 1;
    if (actor.contextOpened) context += 1;
    returns += RETURN_BUCKET_WEIGHTS[actor.returnVisitBucket];
    if (toNonNegative(actor.savedForLater) > 0) saves += 1;
    const contribution = actorV1Contribution(actor, config);
    contributions += contribution.value;
    if (contribution.annotations.length > 0) {
      actorAnnotations.set(actor.actor, contribution.annotations);
    }
  }
  const attention = applySaturation({ dwell, source, context }, config.attentionDimensions);
  const participation = applySaturation(
    { returns, saves, contributions },
    config.participationDimensions,
  );
  return {
    activeAttention: attention.total,
    participation: participation.total,
    attentionDimensions: attention.perDimension,
    participationDimensions: participation.perDimension,
    actorAnnotations,
  };
}
