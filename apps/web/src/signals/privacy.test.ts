// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  assertNoRawEgress,
  PRIVACY_BUCKET,
  resolveCollectionPolicy,
  resolveIdentifier,
} from './privacy.js';

describe('resolveIdentifier', () => {
  it('uses the user id at standard and reduced levels', () => {
    expect(resolveIdentifier('user-1', 'standard')).toBe('user-1');
    expect(resolveIdentifier('user-1', 'reduced')).toBe('user-1');
  });

  it('uses a coarse bucket at minimum privacy', () => {
    expect(resolveIdentifier('user-1', 'minimum')).toBe(PRIVACY_BUCKET);
  });

  it('uses a coarse bucket when there is no user id', () => {
    expect(resolveIdentifier(null, 'standard')).toBe(PRIVACY_BUCKET);
  });
});

describe('resolveCollectionPolicy', () => {
  it('stops collection when personalization is disabled', () => {
    const policy = resolveCollectionPolicy(
      { personalization_enabled: false, privacy_level: 'standard' },
      'user-1',
    );
    expect(policy.collect).toBe(false);
  });

  it('collects with the user id when personalization is on at standard privacy', () => {
    const policy = resolveCollectionPolicy(
      { personalization_enabled: true, privacy_level: 'standard' },
      'user-1',
    );
    expect(policy).toEqual({ collect: true, privacyLevel: 'standard', identifier: 'user-1' });
  });
});

describe('assertNoRawEgress', () => {
  it('passes a bucketed aggregate', () => {
    expect(() =>
      assertNoRawEgress({
        story_id: 'x',
        active_dwell_bucket: 'short',
        source_opened: true,
        privacy_level: 'minimum',
      }),
    ).not.toThrow();
  });

  it('throws when a raw scroll trace would egress', () => {
    expect(() => assertNoRawEgress({ scrollY: 1200 })).toThrow(/forbidden key/);
  });

  it('throws on a nested raw event array', () => {
    expect(() =>
      assertNoRawEgress({ aggregate: { rawEvents: [{ clientX: 1, clientY: 2 }] } }),
    ).toThrow();
  });

  it('throws when a raw dwell duration would egress', () => {
    expect(() => assertNoRawEgress({ dwellMs: 42_000 })).toThrow();
  });
});
