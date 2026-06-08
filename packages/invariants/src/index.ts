import { z } from 'zod';

export const invariantReasonCodeSchema = z.enum([
  'insufficient-signal',
  'bounded-confidence',
  'mathematically-verified',
  'fallback-applied',
]);

export const invariantOutputSchema = z.object({
  name: z.string().min(1),
  score: z.number().finite(),
  confidence: z.number().min(0).max(1),
  coverage: z.number().min(0).max(1),
  reasonCodes: z.array(invariantReasonCodeSchema).min(1),
  fallbackUsed: z.boolean(),
});

export type InvariantOutput = z.infer<typeof invariantOutputSchema>;

export function boundedWeightedMean(values: readonly number[], weights: readonly number[]): number {
  if (values.length === 0 || values.length !== weights.length) {
    throw new Error('values and weights must be non-empty arrays of equal length');
  }

  const totalWeight = weights.reduce((sum, weight) => {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error('weights must be finite non-negative numbers');
    }
    return sum + weight;
  }, 0);

  if (totalWeight <= 0) {
    throw new Error('at least one weight must be positive');
  }

  return values.reduce((sum, value, index) => {
    if (!Number.isFinite(value)) {
      throw new Error('values must be finite numbers');
    }
    const weight = weights[index];
    if (weight === undefined) {
      throw new Error('missing weight');
    }
    return sum + value * (weight / totalWeight);
  }, 0);
}
