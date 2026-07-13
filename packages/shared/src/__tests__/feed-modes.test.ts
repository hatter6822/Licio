// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC §11.6 feed sort modes: the canonical set, the legacy rollout-compat
// mapping (total normalization), and the durable-write spelling
// (`legacyPreservingFeedMode`) — the invariants the stale-bundle compat
// contract rests on. Delete alongside LEGACY_FEED_MODES at the compat cut.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEED_MODE,
  FEED_MODES,
  feedModeCompatSchema,
  LEGACY_FEED_MODES,
  legacyPreservingFeedMode,
  normalizeFeedMode,
} from '../schemas/feed.js';

describe('normalizeFeedMode', () => {
  it('is total: canonical passes through, legacy maps, garbage defaults', () => {
    for (const mode of FEED_MODES) expect(normalizeFeedMode(mode)).toBe(mode);
    expect(normalizeFeedMode('balanced')).toBe('best');
    expect(normalizeFeedMode('source-diverse')).toBe('best');
    expect(normalizeFeedMode('local')).toBe('best');
    expect(normalizeFeedMode('chronological')).toBe('new');
    // The reduce-personalization intent survives: `new` is non-personalized.
    expect(normalizeFeedMode('low-personalization')).toBe('new');
    expect(normalizeFeedMode(undefined)).toBe(DEFAULT_FEED_MODE);
    expect(normalizeFeedMode(null)).toBe(DEFAULT_FEED_MODE);
    expect(normalizeFeedMode('bogus')).toBe(DEFAULT_FEED_MODE);
  });
});

describe('legacyPreservingFeedMode (the durable-write spelling)', () => {
  it('never changes the CANONICAL meaning (lossless round trip)', () => {
    // The stored spelling must normalize back to exactly what the writer
    // meant — for every acceptable wire value, legacy included.
    for (const mode of [...FEED_MODES, ...LEGACY_FEED_MODES]) {
      expect(normalizeFeedMode(legacyPreservingFeedMode(mode))).toBe(normalizeFeedMode(mode));
    }
  });

  it('downgrades best/new to their legacy spellings; legacy values pass through', () => {
    // A stale bundle on the same account validates the echoed settings value
    // against the OLD enum, so the modes WITH a legacy spelling store it.
    expect(legacyPreservingFeedMode('best')).toBe('balanced');
    expect(legacyPreservingFeedMode('new')).toBe('chronological');
    for (const legacy of LEGACY_FEED_MODES) {
      expect(legacyPreservingFeedMode(legacy)).toBe(legacy);
    }
  });

  it('the three genuinely new sorts store canonically (no lossy downgrade)', () => {
    // No legacy spelling exists for them; downgrading would LOSE the
    // preference for updated devices (the documented, self-healing residual).
    for (const mode of ['rising', 'sources', 'debates'] as const) {
      expect(legacyPreservingFeedMode(mode)).toBe(mode);
    }
  });

  it('every stored spelling stays wire-acceptable', () => {
    for (const mode of [...FEED_MODES, ...LEGACY_FEED_MODES]) {
      expect(feedModeCompatSchema.safeParse(legacyPreservingFeedMode(mode)).success).toBe(true);
    }
  });
});
