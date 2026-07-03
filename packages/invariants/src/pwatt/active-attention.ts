// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ActiveAttention component (WS-E.2.1b, SPEC §5.3/§5.4). Pure and total.
//
// Per-actor: a(u) = wD·dwell(u) + wS·source(u) + wC·context(u) + wT·traverse(u)
//            ∈ [0, 1].
//   • dwell(u) maps the bucket through a monotone weight table whose top value
//     is 1 — the per-item cap is the bucket ceiling itself (WS-C.4.1c upstream
//     caps the raw input; here no bucket can yield more than 1).
//   • source(u) is 1 only for a NON-bounce source open: a bounce-only open
//     earns exactly 0 (§5.3 "do not reward clickbait if the user immediately
//     returns").
//   • context(u) counts once (deduped upstream, once per meaningful session).
//   • traverse(u) maps the reply-depth bucket (distinct nested comment depths
//     visited) through a monotone table (§5.3 "thread traversal": reading
//     multiple branches; nonredundant traversal weighted above same-branch
//     re-reads, which the client's DISTINCT-depth count already enforces).
//   • Idle/bounce filtering: `none` dwell and bounce-only opens contribute 0.
//
// Item: A = S / (S + k) with S = Σ_u a(u) and half-saturation k > 0 — strictly
// increasing in S, bounded in [0, 1), so the score is normalized to the 0-1
// range within the window and NO single user can contribute more than 1 to S
// (per-user/item cap). Pure: no clock, no randomness.
import type { DwellBucket, ReplyDepthBucket } from '@licio/shared';
import type { ActorItemSummary } from './types.js';
import { actorTrustFactor, clamp01 } from './types.js';

/** Per-actor dimension weights, integer percents summing to 100, each <= 50. */
export interface ActiveAttentionWeights {
  dwellPct: number;
  sourcePct: number;
  contextPct: number;
  /** Thread-traversal share (§5.3 SIG-ATT-TRAVERSE). */
  traversalPct: number;
}

/**
 * Monotone reply-depth (thread-traversal) weights. `none` (no nested reading)
 * is 0; the ceiling is 1 at `deep`. Diminishing marginal value across buckets.
 */
export const REPLY_DEPTH_BUCKET_WEIGHTS: Readonly<Record<ReplyDepthBucket, number>> = {
  none: 0,
  shallow: 0.4,
  moderate: 0.7,
  deep: 1,
};

export interface ActiveAttentionConfig {
  weights: ActiveAttentionWeights;
  /**
   * Half-saturation constant k (effective engaged actors at which the item
   * score reaches 0.5). Must be > 0.
   */
  halfSaturationActors: number;
}

/**
 * Monotone dwell-bucket weights. `none` is idle-filtered to 0; `glance` (the
 * bounce-adjacent bucket) earns minimal weight; the ceiling is 1 (per-item cap).
 */
export const DWELL_BUCKET_WEIGHTS: Readonly<Record<DwellBucket, number>> = {
  none: 0,
  glance: 0.1,
  short: 0.4,
  medium: 0.7,
  long: 0.9,
  extended: 1,
};

export const DEFAULT_ACTIVE_ATTENTION_CONFIG: ActiveAttentionConfig = {
  weights: { dwellPct: 40, sourcePct: 25, contextPct: 20, traversalPct: 15 },
  halfSaturationActors: 8,
};

/** Validate config: integer percents, each in [1, 50], sum 100, k > 0. */
export function validateActiveAttentionConfig(config: ActiveAttentionConfig): void {
  const { dwellPct, sourcePct, contextPct, traversalPct } = config.weights;
  const parts = [dwellPct, sourcePct, contextPct, traversalPct];
  if (!parts.every((p) => Number.isInteger(p) && p >= 1 && p <= 50)) {
    throw new Error('active-attention weights must be integer percents in [1, 50]');
  }
  if (dwellPct + sourcePct + contextPct + traversalPct !== 100) {
    throw new Error('active-attention weights must sum to exactly 100');
  }
  if (!(config.halfSaturationActors > 0) || !Number.isFinite(config.halfSaturationActors)) {
    throw new Error('halfSaturationActors must be a finite positive number');
  }
}

/** One actor's bounded active-attention contribution in [0, 1]. */
export function actorActiveAttention(
  actor: Pick<
    ActorItemSummary,
    'dwellBucket' | 'sourceOpened' | 'sourceBounceOnly' | 'contextOpened' | 'replyDepthBucket'
  >,
  config: ActiveAttentionConfig = DEFAULT_ACTIVE_ATTENTION_CONFIG,
): number {
  const { dwellPct, sourcePct, contextPct, traversalPct } = config.weights;
  const dwell = DWELL_BUCKET_WEIGHTS[actor.dwellBucket];
  const source = actor.sourceOpened && !actor.sourceBounceOnly ? 1 : 0;
  const context = actor.contextOpened ? 1 : 0;
  const traverse = REPLY_DEPTH_BUCKET_WEIGHTS[actor.replyDepthBucket ?? 'none'];
  return clamp01(
    (dwellPct / 100) * dwell +
      (sourcePct / 100) * source +
      (contextPct / 100) * context +
      (traversalPct / 100) * traverse,
  );
}

/**
 * The item's ActiveAttention score in [0, 1) for a window: the saturating sum
 * of bounded per-actor contributions, each scaled by the actor's account-age
 * trust weight (WS-O.4.5) so a fresh-account brigade contributes less than an
 * aged community of the same size (anonymity is never penalized — the coarse
 * privacy bucket carries full trust). Absent trust weight ⇒ factor 1.
 */
export function itemActiveAttention(
  actors: readonly Pick<
    ActorItemSummary,
    | 'dwellBucket'
    | 'sourceOpened'
    | 'sourceBounceOnly'
    | 'contextOpened'
    | 'replyDepthBucket'
    | 'trustWeight'
  >[],
  config: ActiveAttentionConfig = DEFAULT_ACTIVE_ATTENTION_CONFIG,
): number {
  let sum = 0;
  for (const actor of actors) sum += actorTrustFactor(actor) * actorActiveAttention(actor, config);
  return clamp01(sum / (sum + config.halfSaturationActors));
}
