// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hodge Conversation Tension — labels, routing, and HarmfulTensionRisk
// (WS-H.7.1c, SPEC §12.1).
//
// The non-negotiable: harmonic tension ALONE never penalizes legitimate
// sustained disagreement. `HarmfulTensionRisk` is multiplicative in the
// hostility signal, so it is identically zero whenever hostility is zero —
// however high the structural conflict (property-tested).

export const HODGE_THREAD_LABELS = [
  'low_tension',
  'local_friction',
  'high_disagreement_low_hostility',
  'global_unresolved_conflict',
] as const;
export type HodgeThreadLabel = (typeof HODGE_THREAD_LABELS)[number];

export interface HodgeLabelConfig {
  /** Harmonic fraction at or above which structural conflict is "high". */
  highHarmonicFraction: number;
  /** Curl fraction at or above which local friction is notable. */
  highCurlFraction: number;
  /** Hostility signal at or above which conflict is hostile. */
  hostilityThreshold: number;
}

export const DEFAULT_HODGE_LABEL_CONFIG: HodgeLabelConfig = {
  highHarmonicFraction: 0.3,
  highCurlFraction: 0.3,
  hostilityThreshold: 0.5,
};

export interface HodgeTensionInput {
  /** ‖harmonic‖²/‖flow‖² from the decomposition. */
  harmonicFraction: number;
  /** ‖curl‖²/‖flow‖². */
  curlFraction: number;
  /** Hostility/safety classifier signal ∈ [0, 1] (WS-J seam). */
  hostilitySignal: number;
}

export interface HodgeTensionAssessment {
  label: HodgeThreadLabel;
  /** harmonicFraction × hostility — zero without hostility. */
  harmfulTensionRisk: number;
  routeToModerators: boolean;
}

export function assessTension(
  input: HodgeTensionInput,
  config: HodgeLabelConfig = DEFAULT_HODGE_LABEL_CONFIG,
): HodgeTensionAssessment {
  const hostility = Math.min(1, Math.max(0, input.hostilitySignal));
  const highHarmonic = input.harmonicFraction >= config.highHarmonicFraction;
  const hostile = hostility >= config.hostilityThreshold;
  let label: HodgeThreadLabel;
  if (highHarmonic && hostile) label = 'global_unresolved_conflict';
  else if (highHarmonic) label = 'high_disagreement_low_hostility';
  else if (input.curlFraction >= config.highCurlFraction) label = 'local_friction';
  else label = 'low_tension';
  return {
    label,
    harmfulTensionRisk: input.harmonicFraction * hostility,
    routeToModerators: label === 'global_unresolved_conflict',
  };
}
