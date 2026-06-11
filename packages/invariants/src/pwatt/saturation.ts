// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Saturation curves (WS-E.2.3a, SPEC §5.5/§30.5) — the v1 structural defense
// against volume gaming. Every curve f satisfies, for n >= 0:
//   • totality      — f is defined for every numeric input (NaN/negatives → 0),
//   • f(0) = 0,
//   • boundedness   — f(n) <= 1,
//   • monotonicity  — n2 >= n1 ⇒ f(n2) >= f(n1)  (more signal never lowers it),
//   • diminishing returns — f is concave on [0, ∞) (the logarithmic curve is
//     strictly concave until its cap; tanh is strictly concave on [0, ∞)), so
//     the Nth instance of a signal contributes no more than the (N-1)th.
// These properties are exercised by deterministic property tests.
//
// The 50% dominance cap: each dimension's weight is an integer percent <= 50,
// and weights sum to exactly 100, so no single dimension can ever exceed 50%
// of the maximum total positive score regardless of input volume. Integer
// percents make the sum check exact (no floating-point drift).
import { clamp01, toNonNegative } from './types.js';

/** A configurable diminishing-returns curve (parameters are data, not code). */
export type SaturationCurve =
  | {
      kind: 'logarithmic';
      /** Horizontal scale; larger ⇒ slower saturation. Must be > 0. */
      scale: number;
      /** The input at which the curve reaches exactly 1 (then stays flat). */
      saturationPoint: number;
    }
  | {
      kind: 'sigmoid';
      /** Horizontal scale of tanh(n / scale); larger ⇒ slower saturation. */
      scale: number;
    };

/** Validate curve parameters; throws on a non-positive parameter. */
export function validateCurve(curve: SaturationCurve): void {
  if (curve.kind === 'logarithmic') {
    if (!(curve.scale > 0) || !Number.isFinite(curve.scale)) {
      throw new Error('logarithmic curve requires finite scale > 0');
    }
    if (!(curve.saturationPoint > 0) || !Number.isFinite(curve.saturationPoint)) {
      throw new Error('logarithmic curve requires finite saturationPoint > 0');
    }
    return;
  }
  if (!(curve.scale > 0) || !Number.isFinite(curve.scale)) {
    throw new Error('sigmoid curve requires finite scale > 0');
  }
}

/**
 * Apply a saturation curve. Logarithmic: ln(1 + n/s) / ln(1 + N/s), capped at
 * 1 from the saturation point N onward. Sigmoid: tanh(n / s), asymptote 1.
 */
export function saturate(count: number, curve: SaturationCurve): number {
  const n = toNonNegative(count);
  if (n === 0) return 0;
  if (curve.kind === 'logarithmic') {
    const ratio = Math.log(1 + n / curve.scale) / Math.log(1 + curve.saturationPoint / curve.scale);
    return clamp01(ratio);
  }
  return clamp01(Math.tanh(n / curve.scale));
}

/** One saturating signal dimension: an integer-percent weight + its curve. */
export interface SaturationDimension {
  /** Integer percent share of the component budget; 1..50 (dominance cap). */
  weightPct: number;
  curve: SaturationCurve;
}

/** The maximum share any single dimension may hold (WS-E.2.3a: 50%). */
export const DIMENSION_DOMINANCE_CAP_PCT = 50;

/**
 * Validate a dimension set: integer weights, each in [1, 50], summing to
 * exactly 100, and every curve well-formed. Throws with every violation named
 * (config-time rejection, WS-E.2.3a).
 */
export function validateSaturationDimensions(
  dimensions: Readonly<Record<string, SaturationDimension>>,
): void {
  const names = Object.keys(dimensions);
  if (names.length === 0) throw new Error('at least one saturation dimension is required');
  const problems: string[] = [];
  let sum = 0;
  for (const name of names) {
    const dimension = dimensions[name];
    if (!dimension) continue;
    if (!Number.isInteger(dimension.weightPct)) {
      problems.push(`${name}: weightPct must be an integer percent`);
    } else if (dimension.weightPct < 1 || dimension.weightPct > DIMENSION_DOMINANCE_CAP_PCT) {
      problems.push(
        `${name}: weightPct ${dimension.weightPct} outside [1, ${DIMENSION_DOMINANCE_CAP_PCT}] (50% dominance cap)`,
      );
    }
    try {
      validateCurve(dimension.curve);
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message : 'invalid curve'}`);
    }
    sum += dimension.weightPct;
  }
  if (sum !== 100) problems.push(`dimension weights must sum to exactly 100, got ${sum}`);
  if (problems.length > 0) {
    throw new Error(`invalid saturation dimensions: ${problems.join('; ')}`);
  }
}

/**
 * Saturate a vector of per-dimension counts. Returns each dimension's weighted
 * contribution (== weightPct/100 × saturate(count) <= 0.5) and the total
 * (<= 1). Dimensions absent from `counts` contribute 0; unknown count keys are
 * ignored (the config is the closed dimension set).
 */
export function applySaturation(
  counts: Readonly<Record<string, number>>,
  dimensions: Readonly<Record<string, SaturationDimension>>,
): { perDimension: Record<string, number>; total: number } {
  const perDimension: Record<string, number> = {};
  let total = 0;
  for (const [name, dimension] of Object.entries(dimensions)) {
    const value = (dimension.weightPct / 100) * saturate(counts[name] ?? 0, dimension.curve);
    perDimension[name] = value;
    total += value;
  }
  return { perDimension, total: clamp01(total) };
}
