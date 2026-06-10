// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PWAtt v0 (WS-E.2.1b/c, SPEC §30.5 "instrumented salience, no distribution
// power"). The v0 score is the unweighted mean of the two implemented
// components — there is no baseline and no penalty integration yet (those are
// v1, WS-E.2.3) — computed purely so the same window input always reproduces
// the same score (shadow-mode equivalence, WS-E.2.1e).
import {
  type ActiveAttentionConfig,
  actorActiveAttention,
  DEFAULT_ACTIVE_ATTENTION_CONFIG,
  itemActiveAttention,
  validateActiveAttentionConfig,
} from './active-attention.js';
import {
  DEFAULT_PARTICIPATION_CONFIG,
  itemParticipation,
  type ParticipationConfig,
  validateParticipationConfig,
} from './participation.js';
import {
  type ActorScoreBreakdown,
  clamp01,
  type ItemWindowInput,
  type PwattV0Result,
} from './types.js';

export interface PwattV0Config {
  activeAttention: ActiveAttentionConfig;
  participation: ParticipationConfig;
  /** Distinct actors at which confidence reaches 0.5. Must be > 0. */
  confidenceHalfSaturation: number;
}

export const DEFAULT_PWATT_V0_CONFIG: PwattV0Config = {
  activeAttention: DEFAULT_ACTIVE_ATTENTION_CONFIG,
  participation: DEFAULT_PARTICIPATION_CONFIG,
  confidenceHalfSaturation: 3,
};

export function validatePwattV0Config(config: PwattV0Config): void {
  validateActiveAttentionConfig(config.activeAttention);
  validateParticipationConfig(config.participation);
  if (!(config.confidenceHalfSaturation > 0)) {
    throw new Error('confidenceHalfSaturation must be > 0');
  }
}

/** Compute the PWAtt v0 shadow score for one item/window. Pure and total. */
export function computePwattV0(
  input: ItemWindowInput,
  config: PwattV0Config = DEFAULT_PWATT_V0_CONFIG,
): PwattV0Result {
  const activeAttention = itemActiveAttention(input.actors, config.activeAttention);
  const participation = itemParticipation(input.actors, input.antiSignals, config.participation);

  const actorBreakdowns: ActorScoreBreakdown[] = input.actors.map((actor) => {
    const participationResult = participation.perActor.get(actor.actor);
    return {
      actor: actor.actor,
      activeAttention: actorActiveAttention(actor, config.activeAttention),
      participation: participationResult?.value ?? 0,
      annotations: participationResult?.annotations ?? [],
    };
  });

  // Confidence grows with independent evidence (distinct actors), saturating
  // like the component scores; a single-actor window is low-confidence.
  const distinctActors = new Set(input.actors.map((a) => a.actor)).size;
  const confidence = clamp01(distinctActors / (distinctActors + config.confidenceHalfSaturation));

  return {
    itemId: input.itemId,
    activeAttention,
    participation: participation.value,
    score: clamp01((activeAttention + participation.value) / 2),
    confidence,
    annotations: participation.annotations,
    actorBreakdowns,
  };
}
