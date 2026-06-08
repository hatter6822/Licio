import { describe, expect, it } from 'vitest';
import { boundedWeightedMean, invariantOutputSchema } from './index.js';

describe('invariant primitives', () => {
  it('computes a normalized weighted mean', () => {
    expect(boundedWeightedMean([1, 3], [1, 3])).toBe(2.5);
  });

  it('rejects invalid inputs to preserve mathematical soundness', () => {
    expect(() => boundedWeightedMean([], [])).toThrow(/non-empty/);
    expect(() => boundedWeightedMean([1], [1, 2])).toThrow(/equal length/);
    expect(() => boundedWeightedMean([1], [-1])).toThrow(/non-negative/);
    expect(() => boundedWeightedMean([1], [Number.NaN])).toThrow(/finite/);
    expect(() => boundedWeightedMean([1], [0])).toThrow(/positive/);
    expect(() => boundedWeightedMean([Number.POSITIVE_INFINITY], [1])).toThrow(/finite/);
  });

  it('validates invariant outputs with bounded confidence and coverage', () => {
    expect(
      invariantOutputSchema.parse({
        name: 'MERI',
        score: 0.25,
        confidence: 0.9,
        coverage: 0.8,
        reasonCodes: ['mathematically-verified'],
        fallbackUsed: false,
      }),
    ).toMatchObject({ name: 'MERI' });
  });
});
