// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.2a — bias/subgroup audit math. The normal CDF and two-proportion z-test
// are checked against known values; the audit computes per-subgroup disparities,
// blocks a significant above-threshold gap, honors a documented acceptance, and
// applies small-cohort protection.
import { describe, expect, it } from 'vitest';
import {
  computeBiasAudit,
  disparityKey,
  normalCdf,
  type SubgroupMetric,
  twoProportionPValue,
} from '../index.js';

describe('normalCdf', () => {
  it('matches known standard-normal values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normalCdf(2.5758)).toBeCloseTo(0.995, 3);
  });
});

describe('twoProportionPValue', () => {
  it('is 1 for equal proportions', () => {
    expect(twoProportionPValue(0.8, 100, 0.8, 100)).toBe(1);
  });
  it('is 1 when a sample is empty', () => {
    expect(twoProportionPValue(0.9, 0, 0.5, 100)).toBe(1);
  });
  it('is small for a large, clear gap', () => {
    expect(twoProportionPValue(0.95, 500, 0.7, 500)).toBeLessThan(0.001);
  });
  it('is large for a tiny gap on small samples', () => {
    expect(twoProportionPValue(0.81, 40, 0.79, 40)).toBeGreaterThan(0.1);
  });
  it('reports p=0 for a real gap with degenerate pooled variance', () => {
    expect(twoProportionPValue(1, 100, 0, 100)).toBe(0);
  });
});

const metric = (
  over: Partial<SubgroupMetric> & Pick<SubgroupMetric, 'subgroup'>,
): SubgroupMetric => ({
  dimension: 'language',
  sample_size: 500,
  accuracy: 0.9,
  ...over,
});

describe('computeBiasAudit', () => {
  it('blocks a significant disparity above threshold', () => {
    const result = computeBiasAudit(
      [metric({ subgroup: 'en', accuracy: 0.95 }), metric({ subgroup: 'sw', accuracy: 0.7 })],
      { threshold: 0.1 },
    );
    expect(result.passed).toBe(false);
    const disparity = result.disparities.find((d) => d.metric === 'accuracy');
    expect(disparity?.disparity).toBeCloseTo(0.25, 6);
    expect(disparity?.significant).toBe(true);
    expect(disparity?.best_subgroup).toBe('en');
    expect(disparity?.worst_subgroup).toBe('sw');
  });

  it('passes when a documented acceptance covers the gap', () => {
    const result = computeBiasAudit(
      [metric({ subgroup: 'en', accuracy: 0.95 }), metric({ subgroup: 'sw', accuracy: 0.7 })],
      {
        threshold: 0.1,
        acceptedDisparities: new Set([disparityKey('language', 'accuracy')]),
        justification: 'low-resource language; mitigation tracked',
      },
    );
    expect(result.passed).toBe(true);
    expect(result.accepted_with_documentation).toBe(true);
    expect(result.justification).not.toBeNull();
  });

  it('passes when the gap is below threshold', () => {
    const result = computeBiasAudit(
      [metric({ subgroup: 'en', accuracy: 0.92 }), metric({ subgroup: 'sw', accuracy: 0.9 })],
      { threshold: 0.1 },
    );
    expect(result.passed).toBe(true);
  });

  it('excludes small cohorts from the comparison (small-cohort protection)', () => {
    const result = computeBiasAudit(
      [
        metric({ subgroup: 'en', accuracy: 0.95, sample_size: 500 }),
        metric({ subgroup: 'rare', accuracy: 0.4, sample_size: 5 }),
      ],
      { threshold: 0.1, minSampleSize: 30 },
    );
    // Only one eligible subgroup ⇒ no disparity computed ⇒ passes.
    expect(result.disparities).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it('handles generation-model quality scores', () => {
    const result = computeBiasAudit(
      [
        {
          dimension: 'topic_sensitivity',
          subgroup: 'neutral',
          sample_size: 300,
          quality_score: 0.9,
        },
        {
          dimension: 'topic_sensitivity',
          subgroup: 'sensitive',
          sample_size: 300,
          quality_score: 0.6,
        },
      ],
      { threshold: 0.1 },
    );
    const disparity = result.disparities.find((d) => d.metric === 'quality_score');
    expect(disparity).toBeDefined();
    expect(result.passed).toBe(false);
  });
});
