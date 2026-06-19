// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.3c — accuracy metrics from steward corrections. Correction and agreement
// rates and per-category roll-ups are computed; an empty set yields zeros.
import { describe, expect, it } from 'vitest';
import { type AiCorrection, computeAccuracyMetrics } from '../index.js';

const correction = (over: Partial<AiCorrection> & Pick<AiCorrection, 'action'>): AiCorrection => ({
  correction_id: 'x',
  output_id: 'o',
  use_case_id: 'topic_classification',
  original_value: 'orig',
  corrected_value: over.action === 'modify' ? 'fixed' : null,
  steward_ref: 'steward:1',
  category: null,
  corrected_at: '2026-06-19T00:00:00.000Z',
  ...over,
});

describe('WS-K.1.3c computeAccuracyMetrics', () => {
  it('computes correction and agreement rates', () => {
    const metrics = computeAccuracyMetrics(
      'topic_classification',
      [
        correction({ action: 'confirm' }),
        correction({ action: 'confirm' }),
        correction({ action: 'reject' }),
        correction({ action: 'modify' }),
      ],
      '2026-06-19T00:00:00.000Z',
    );
    expect(metrics.total).toBe(4);
    expect(metrics.confirmed).toBe(2);
    expect(metrics.agreement_rate).toBe(0.5);
    expect(metrics.correction_rate).toBe(0.5);
  });

  it('rolls up per category', () => {
    const metrics = computeAccuracyMetrics(
      'topic_classification',
      [
        correction({ action: 'confirm', category: 'climate' }),
        correction({ action: 'reject', category: 'climate' }),
        correction({ action: 'confirm', category: 'policy' }),
      ],
      '2026-06-19T00:00:00.000Z',
    );
    const climate = metrics.per_category.find((c) => c.category === 'climate');
    expect(climate).toEqual({ category: 'climate', total: 2, agreement_rate: 0.5 });
    const policy = metrics.per_category.find((c) => c.category === 'policy');
    expect(policy?.agreement_rate).toBe(1);
  });

  it('filters by use case and yields zeros for an empty set', () => {
    const metrics = computeAccuracyMetrics(
      'summarization',
      [correction({ action: 'confirm', use_case_id: 'topic_classification' })],
      '2026-06-19T00:00:00.000Z',
    );
    expect(metrics.total).toBe(0);
    expect(metrics.correction_rate).toBe(0);
    expect(metrics.agreement_rate).toBe(0);
  });
});
