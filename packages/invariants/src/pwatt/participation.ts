// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ConstructiveParticipation component (WS-E.2.1c, SPEC §5.3/§5.4). Pure/total.
//
// Per-actor: p(u) = wR·return(u) + wV·save(u) + wK·contrib(u) ∈ [0, 1].
//   • return(u): the bucket weight table is itself diminishing — the marginal
//     value PER RETURN falls strictly across buckets (0.5 for the first
//     bucket's <= 2 returns, then <= 0.1, then <= 0.04) and rage-loops were
//     already excluded upstream (§5.3 "avoid rewarding obsessive loops").
//   • save(u): private saves earn LOW weight (§19.2: private by default) —
//     the save dimension's whole budget is 10%.
//   • contrib(u): v0 uses uniform weights for constructive types and ZERO for
//     `low_info_reply` and `flag` (§5.3: volume, not constructive
//     participation). Source-free accusations keep only `accusationDownweight`
//     of their unit weight (WS-E.2.2b — scoring only, never visibility).
//     Saturates linearly to a per-user cap (`contribSaturation` units = 1).
//   • Rapid-repetition anti-signal: more than `rapidThreshold` contributions
//     in one window multiplies contrib(u) by `rapidDampening` (< 1) — an
//     anti-signal can only ever reduce a score, never raise it.
//
// Item: P = T / (T + k), T = Σ_u p(u): bounded, monotone, normalized to [0, 1).
// In v0 SHADOW, a detected coordinated burst applies only the placeholder
// dampening factor and an annotation (no ranking power either way, §30.5).
import type { EventContributionType, ReturnVisitBucket } from '@licio/shared';
import type { ActorItemSummary, ItemAntiSignals } from './types.js';
import { actorTrustFactor, clamp01, toNonNegative } from './types.js';

/** Per-actor dimension weights, integer percents summing to 100, each <= 50. */
export interface ParticipationWeights {
  returnPct: number;
  savePct: number;
  contributionPct: number;
}

export interface ParticipationConfig {
  weights: ParticipationWeights;
  /** Constructive units at which contrib(u) reaches its per-user cap of 1. */
  contribSaturation: number;
  /** Window contribution count beyond which rapid-repetition dampening applies. */
  rapidThreshold: number;
  /** Multiplier (< 1) applied to contrib(u) when rapid repetition is detected. */
  rapidDampening: number;
  /** Fraction of unit weight an uncited accusation keeps (WS-E.2.2b). */
  accusationDownweight: number;
  /** WS-T sourced-comment bonus in [0, 1]: extra unit weight a sourced
   *  contribution earns over an unsourced one (v0/ledger parity with v1). */
  citationBonus: number;
  /** v0 SHADOW placeholder multiplier for a detected coordinated burst. */
  burstPlaceholderDampening: number;
  /** Half-saturation constant for the item-level score. Must be > 0. */
  halfSaturationActors: number;
}

/**
 * Return-visit bucket weights. Marginal value per additional return falls
 * strictly: `few` (1-2 returns) ⇒ <= 0.5/return; `several` (3-5) ⇒ 0.1/return;
 * `many` (6+) ⇒ <= 0.04/return. Diminishing returns by construction.
 */
export const RETURN_BUCKET_WEIGHTS: Readonly<Record<ReturnVisitBucket, number>> = {
  none: 0,
  few: 0.5,
  several: 0.8,
  many: 1,
};

/**
 * v0 contribution-type weights (WS-E.2.1c): uniform 1 for constructive types,
 * 0 for `low_info_reply` (anti-signal volume) and `flag` (a safety action, not
 * content participation). The v1 hierarchy (WS-E.2.3b) replaces this table.
 */
export const V0_CONTRIBUTION_WEIGHTS: Readonly<Record<EventContributionType, number>> = {
  question: 1,
  evidence: 1,
  correction: 1,
  synthesis: 1,
  counterexample: 1,
  explanation: 1,
  experience: 1,
  bridge_comment: 1,
  steward_action: 1,
  flag: 0,
  low_info_reply: 0,
};

export const DEFAULT_PARTICIPATION_CONFIG: ParticipationConfig = {
  // `savePct` carries the §5.3 "Save for later" LOW rank weight now that the
  // privacy-respecting `content.saved` signal flows (the save aggregate rides
  // the attention privacy pipeline; the saved COLLECTION stays client-local,
  // §19.2). Contribution stays dominant (the platform rewards depth).
  weights: { returnPct: 40, savePct: 10, contributionPct: 50 },
  contribSaturation: 3,
  rapidThreshold: 5,
  rapidDampening: 0.3,
  accusationDownweight: 0.25,
  citationBonus: 0.35,
  burstPlaceholderDampening: 0.9,
  halfSaturationActors: 5,
};

/** Validate config (config-time rejection of invalid parameters). */
export function validateParticipationConfig(config: ParticipationConfig): void {
  const { returnPct, savePct, contributionPct } = config.weights;
  const parts = [returnPct, savePct, contributionPct];
  if (!parts.every((p) => Number.isInteger(p) && p >= 1 && p <= 50)) {
    throw new Error('participation weights must be integer percents in [1, 50]');
  }
  if (returnPct + savePct + contributionPct !== 100) {
    throw new Error('participation weights must sum to exactly 100');
  }
  if (!(config.contribSaturation > 0)) throw new Error('contribSaturation must be > 0');
  if (!(config.rapidThreshold >= 1)) throw new Error('rapidThreshold must be >= 1');
  for (const [name, factor] of [
    ['rapidDampening', config.rapidDampening],
    ['accusationDownweight', config.accusationDownweight],
    ['citationBonus', config.citationBonus],
    ['burstPlaceholderDampening', config.burstPlaceholderDampening],
  ] as const) {
    if (!(factor >= 0 && factor <= 1)) throw new Error(`${name} must be in [0, 1]`);
  }
  if (!(config.halfSaturationActors > 0) || !Number.isFinite(config.halfSaturationActors)) {
    throw new Error('halfSaturationActors must be a finite positive number');
  }
}

export interface ActorParticipationResult {
  /** The bounded per-actor participation contribution in [0, 1]. */
  value: number;
  /** Anti-signal annotations applied to this actor (Signal Ledger, §5.3). */
  annotations: string[];
}

type ActorParticipationInput = Pick<
  ActorItemSummary,
  | 'returnVisitBucket'
  | 'contributions'
  | 'uncitedAccusationsByType'
  | 'citedContributionsByType'
  | 'savedForLater'
>;

/** One actor's bounded participation contribution, with annotations. */
export function actorParticipation(
  actor: ActorParticipationInput,
  config: ParticipationConfig = DEFAULT_PARTICIPATION_CONFIG,
): ActorParticipationResult {
  const annotations: string[] = [];

  // Constructive units, with the source-free-accusation downweight: an uncited
  // accusation keeps only `accusationDownweight` of its own type's weight.
  // Per-type uncited counts are clamped to the type's contribution count
  // (defensive: the input invariant is enforced even against a buggy fold).
  let units = 0;
  let totalContributions = 0;
  let uncitedTotal = 0;
  let citedTotal = 0;
  for (const [type, count] of Object.entries(actor.contributions) as Array<
    [EventContributionType, number | undefined]
  >) {
    const n = toNonNegative(count ?? 0);
    totalContributions += n;
    const typeWeight = V0_CONTRIBUTION_WEIGHTS[type] ?? 0;
    const uncited = Math.min(toNonNegative(actor.uncitedAccusationsByType[type] ?? 0), n);
    uncitedTotal += uncited;
    // WS-T — a sourced contribution earns the citation bonus (v0/ledger parity
    // with the served v1 weight, so the honest Signal Ledger reflects it).
    const cited = Math.min(toNonNegative(actor.citedContributionsByType[type] ?? 0), n);
    citedTotal += cited;
    units +=
      typeWeight * (n - uncited) +
      typeWeight * config.accusationDownweight * uncited +
      typeWeight * config.citationBonus * cited;
  }
  if (uncitedTotal > 0) {
    annotations.push('source_free_accusation_downweight');
  }
  if (citedTotal > 0) {
    annotations.push('sourced_contribution_weighted');
  }

  let contrib = clamp01(units / config.contribSaturation);
  if (totalContributions > config.rapidThreshold) {
    contrib *= config.rapidDampening;
    annotations.push('rapid_repetition_dampened');
  }

  const returnScore = RETURN_BUCKET_WEIGHTS[actor.returnVisitBucket];
  const saveScore = toNonNegative(actor.savedForLater) > 0 ? 1 : 0;
  const { returnPct, savePct, contributionPct } = config.weights;
  const value = clamp01(
    (returnPct / 100) * returnScore +
      (savePct / 100) * saveScore +
      (contributionPct / 100) * contrib,
  );
  return { value, annotations };
}

export interface ItemParticipationResult {
  /** The item's ConstructiveParticipation score in [0, 1). */
  value: number;
  /** Item-level annotations (e.g. the v0 burst placeholder dampening). */
  annotations: string[];
  /** Per-actor results keyed by actor id, for ledger population. */
  perActor: Map<string, ActorParticipationResult>;
}

/** The item's participation score for a window, with anti-signal handling. */
export function itemParticipation(
  actors: readonly ActorItemSummary[],
  antiSignals: ItemAntiSignals,
  config: ParticipationConfig = DEFAULT_PARTICIPATION_CONFIG,
): ItemParticipationResult {
  const perActor = new Map<string, ActorParticipationResult>();
  let sum = 0;
  for (const actor of actors) {
    const result = actorParticipation(actor, config);
    // The per-actor map keeps the UNWEIGHTED value (the user's own honest
    // ledger record); account-age trust (WS-O.4.5) scales only the ITEM sum so
    // a fresh-account brigade contributes less distribution power.
    perActor.set(actor.actor, result);
    sum += actorTrustFactor(actor) * result.value;
  }
  let value = clamp01(sum / (sum + config.halfSaturationActors));
  const annotations: string[] = [];
  if (antiSignals.coordinatedBurst) {
    // v0 SHADOW: a placeholder dampening only — recorded for transparency and
    // review, with no ranking power either way (SPEC §30.5).
    value *= config.burstPlaceholderDampening;
    annotations.push('coordinated_burst_placeholder_dampening');
  }
  if (antiSignals.harassmentCascade) {
    // The freeze itself is enforced by the safety-state mechanism
    // (WS-E.2.3e); scoring only annotates so the ledger shows why.
    annotations.push('harassment_cascade_review');
  }
  return { value: clamp01(value), annotations, perActor };
}
