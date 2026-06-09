// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  activeDwellBucket,
  attentionAggregateSchema,
  branchDepthBucket,
  DWELL_BUCKETS,
  returnVisitCountBucket,
  sessionBucket,
} from '../schemas/attention.js';

/** Bucket order index, used to assert monotonicity of the mappings. */
function rank<const T extends readonly string[]>(order: T, value: T[number]): number {
  return order.indexOf(value);
}

describe('activeDwellBucket', () => {
  it('maps representative durations to the expected bucket', () => {
    expect(activeDwellBucket(0)).toBe('none');
    expect(activeDwellBucket(5_000)).toBe('glance');
    expect(activeDwellBucket(10_000)).toBe('short');
    expect(activeDwellBucket(29_999)).toBe('short');
    expect(activeDwellBucket(30_000)).toBe('medium');
    expect(activeDwellBucket(119_999)).toBe('medium');
    expect(activeDwellBucket(120_000)).toBe('long');
    expect(activeDwellBucket(299_999)).toBe('long');
    expect(activeDwellBucket(300_000)).toBe('extended');
  });

  it('collapses NaN and non-positive input to none, Infinity to extended', () => {
    expect(activeDwellBucket(Number.NaN)).toBe('none');
    expect(activeDwellBucket(-1)).toBe('none');
    expect(activeDwellBucket(Number.NEGATIVE_INFINITY)).toBe('none');
    expect(activeDwellBucket(Number.POSITIVE_INFINITY)).toBe('extended');
  });

  it('is monotone non-decreasing across the whole positive range', () => {
    let previous = -1;
    for (let ms = 0; ms <= 360_000; ms += 1_000) {
      const current = rank(DWELL_BUCKETS, activeDwellBucket(ms));
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe('branchDepthBucket', () => {
  it('maps distinct-branch counts to depth buckets', () => {
    expect(branchDepthBucket(0)).toBe('none');
    expect(branchDepthBucket(1)).toBe('shallow');
    expect(branchDepthBucket(2)).toBe('moderate');
    expect(branchDepthBucket(3)).toBe('moderate');
    expect(branchDepthBucket(4)).toBe('deep');
    expect(branchDepthBucket(6)).toBe('deep');
  });

  it('floors fractional input and clamps junk to none', () => {
    expect(branchDepthBucket(1.9)).toBe('shallow');
    expect(branchDepthBucket(-3)).toBe('none');
    expect(branchDepthBucket(Number.NaN)).toBe('none');
  });
});

describe('returnVisitCountBucket', () => {
  it('maps genuine return counts to buckets', () => {
    expect(returnVisitCountBucket(0)).toBe('none');
    expect(returnVisitCountBucket(2)).toBe('few');
    expect(returnVisitCountBucket(3)).toBe('several');
    expect(returnVisitCountBucket(5)).toBe('several');
    expect(returnVisitCountBucket(6)).toBe('many');
    expect(returnVisitCountBucket(1000)).toBe('many');
  });
});

describe('sessionBucket', () => {
  it('floors instants within a window to the same label', () => {
    const windowMs = 3_600_000;
    const base = Date.UTC(2026, 5, 9, 13, 0, 0);
    expect(sessionBucket(base, windowMs)).toBe(sessionBucket(base + 59 * 60_000, windowMs));
    expect(sessionBucket(base, windowMs)).not.toBe(sessionBucket(base + windowMs, windowMs));
  });

  it('produces an ISO label at the window start and tolerates junk input', () => {
    const windowMs = 3_600_000;
    expect(sessionBucket(Date.UTC(2026, 5, 9, 13, 30), windowMs)).toBe('2026-06-09T13:00:00.000Z');
    expect(sessionBucket(Number.NaN)).toBe('1970-01-01T00:00:00.000Z');
    // A non-positive window falls back to the default rather than dividing by 0.
    expect(() => sessionBucket(Date.now(), 0)).not.toThrow();
  });
});

describe('attentionAggregateSchema', () => {
  const valid = {
    aggregate_id: '11111111-1111-4111-8111-111111111111',
    user_id_or_privacy_bucket: '22222222-2222-4222-8222-222222222222',
    story_id: '33333333-3333-4333-8333-333333333333',
    session_bucket: '2026-06-09T13:00:00.000Z',
    active_dwell_bucket: 'medium',
    source_opened: true,
    context_opened: false,
    branch_depth_bucket: 'moderate',
    return_visit_count_bucket: 'few',
    privacy_level: 'standard',
    created_at: '2026-06-09T13:45:00.000Z',
  };

  it('accepts a well-formed aggregate with exactly the eleven §22.1 fields', () => {
    const parsed = attentionAggregateSchema.parse(valid);
    expect(Object.keys(parsed)).toHaveLength(11);
  });

  it('rejects an unknown dwell bucket', () => {
    expect(() =>
      attentionAggregateSchema.parse({ ...valid, active_dwell_bucket: 'forever' }),
    ).toThrow();
  });

  it('rejects a raw dwell number leaking into the bucket field', () => {
    expect(() =>
      attentionAggregateSchema.parse({ ...valid, active_dwell_bucket: 240_000 }),
    ).toThrow();
  });

  it('rejects a non-uuid story id', () => {
    expect(() => attentionAggregateSchema.parse({ ...valid, story_id: 'not-a-uuid' })).toThrow();
  });
});
