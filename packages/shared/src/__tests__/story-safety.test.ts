// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC §22.1 safety-posture derivation: proves the shared cascade the WS-I feed
// and the story-detail read both call, so the two surfaces agree on the safety
// dimension by construction. Also pins the wire schema for the story-card
// signals that replaced the former §5.6 rating labels (sources count +
// corrections tally): defaults keep pre-signal producers/caches valid.
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STORY_CORRECTIONS,
  feedItemSchema,
  LEGACY_RATING_LABELS,
  type StorySafetyState,
  storyCorrectionsSchema,
} from '../schemas/feed.js';
import { STORY_LIFECYCLE_STATES } from '../utils/story-lifecycle.js';
import { deriveStorySafetyState, legacyRatingLabel } from '../utils/story-safety.js';

describe('deriveStorySafetyState — shared safety posture', () => {
  const ok: StorySafetyState = 'ok';
  it('frozen items are under-review (the strongest posture)', () => {
    expect(
      deriveStorySafetyState({ frozen: true, mfciRiskState: 'normal', threadSafetyState: 'open' }),
    ).toBe('under-review');
  });

  it('high/severe MFCI risk is under-review', () => {
    expect(
      deriveStorySafetyState({
        frozen: false,
        mfciRiskState: 'high',
        threadSafetyState: undefined,
      }),
    ).toBe('under-review');
    expect(
      deriveStorySafetyState({
        frozen: false,
        mfciRiskState: 'severe',
        threadSafetyState: undefined,
      }),
    ).toBe('under-review');
  });

  it('a thread under review is under-review', () => {
    expect(
      deriveStorySafetyState({
        frozen: false,
        mfciRiskState: undefined,
        threadSafetyState: 'under_review',
      }),
    ).toBe('under-review');
  });

  it('elevated MFCI risk or an elevated thread is caution', () => {
    expect(
      deriveStorySafetyState({
        frozen: false,
        mfciRiskState: 'elevated',
        threadSafetyState: undefined,
      }),
    ).toBe('caution');
    expect(
      deriveStorySafetyState({
        frozen: false,
        mfciRiskState: undefined,
        threadSafetyState: 'elevated',
      }),
    ).toBe('caution');
  });

  it('a normal, unfrozen, open story is ok', () => {
    expect(
      deriveStorySafetyState({ frozen: false, mfciRiskState: 'normal', threadSafetyState: 'open' }),
    ).toBe(ok);
    expect(
      deriveStorySafetyState({
        frozen: false,
        mfciRiskState: undefined,
        threadSafetyState: undefined,
      }),
    ).toBe(ok);
  });

  it('under-review (frozen) dominates an otherwise-elevated signal', () => {
    expect(
      deriveStorySafetyState({
        frozen: true,
        mfciRiskState: 'elevated',
        threadSafetyState: 'elevated',
      }),
    ).toBe('under-review');
  });

  it('a §18.3-restricted thread reaches the wire restricted posture (never silently ok)', () => {
    // The thread §15.4 safety machine's terminal `restricted` state must NOT
    // collapse to `ok` — it is the strongest posture (access-limited content).
    expect(
      deriveStorySafetyState({
        frozen: false,
        mfciRiskState: undefined,
        threadSafetyState: 'restricted',
      }),
    ).toBe('restricted');
  });

  it('restricted outranks frozen / high-MFCI (the strongest wire posture)', () => {
    expect(
      deriveStorySafetyState({
        frozen: true,
        mfciRiskState: 'severe',
        threadSafetyState: 'restricted',
      }),
    ).toBe('restricted');
  });

  it('is a pure function (same input → same output)', () => {
    const input = {
      frozen: false,
      mfciRiskState: 'elevated' as const,
      threadSafetyState: 'elevated',
    };
    const first = deriveStorySafetyState(input);
    for (let i = 0; i < 50; i += 1) expect(deriveStorySafetyState(input)).toBe(first);
  });
});

describe('story-card signal wire schema (sources count + corrections tally)', () => {
  it('rejects negative or fractional counts', () => {
    expect(
      storyCorrectionsSchema.safeParse({ active: -1, validated: 0, incorrect: 0 }).success,
    ).toBe(false);
    expect(
      storyCorrectionsSchema.safeParse({ active: 0, validated: 0.5, incorrect: 0 }).success,
    ).toBe(false);
    expect(
      storyCorrectionsSchema.safeParse({ active: 2, validated: 1, incorrect: 3 }).success,
    ).toBe(true);
  });

  it('feed items predating the signals stay valid on the wire (defaults)', () => {
    // A cached/offline feed item written before the story-card signal redesign
    // carries neither `sources_count` nor `corrections`; its `rating_label`
    // round-trips through the DEPRECATED compat slot.
    const legacy = feedItemSchema.parse({
      story_id: '3f2a1b04-0000-4000-8000-000000000001',
      title: 'Legacy cached item',
      source: 'example.org',
      reading_minutes: 3,
      rating_label: 'deepening',
      distribution_reason: 'Followed topic',
    });
    expect(legacy.sources_count).toBe(0);
    expect(legacy.corrections).toEqual(EMPTY_STORY_CORRECTIONS);
    expect(legacy.rating_label).toBe('deepening');
  });

  it('the DEPRECATED compat rating_label SURVIVES response validation (rollout)', () => {
    // A pre-redesign cached bundle REQUIRES rating_label on every feed/detail
    // item; the route-level response .parse must therefore keep the emitted
    // compat value rather than stripping it as an unknown key.
    const served = feedItemSchema.parse({
      story_id: '3f2a1b04-0000-4000-8000-000000000002',
      title: 'Served item',
      source: 'example.org',
      reading_minutes: 2,
      sources_count: 1,
      corrections: { active: 0, validated: 0, incorrect: 0 },
      rating_label: 'under-review',
      distribution_reason: 'Recent',
    });
    expect(served.rating_label).toBe('under-review');
  });
});

describe('legacyRatingLabel — the DEPRECATED rollout-compat approximation', () => {
  it('reproduces the retired cascade over safety → lifecycle → attention', () => {
    // Safety review dominates everything (both review and restricted).
    expect(legacyRatingLabel({ lifecycleState: 'stable', safetyState: 'under-review' })).toBe(
      'under-review',
    );
    expect(legacyRatingLabel({ lifecycleState: 'deepening', safetyState: 'restricted' })).toBe(
      'under-review',
    );
    // Lifecycle mapping (caution never surfaced as a label).
    expect(legacyRatingLabel({ lifecycleState: 'context_needed', safetyState: 'caution' })).toBe(
      'needs-context',
    );
    expect(legacyRatingLabel({ lifecycleState: 'bridging', safetyState: 'ok' })).toBe(
      'bridge-active',
    );
    expect(legacyRatingLabel({ lifecycleState: 'stable', safetyState: 'ok' })).toBe(
      'resolved-context',
    );
    expect(legacyRatingLabel({ lifecycleState: 'archived', safetyState: 'ok' })).toBe(
      'resolved-context',
    );
    expect(legacyRatingLabel({ lifecycleState: 'deepening', safetyState: 'ok' })).toBe('deepening');
    // The truthful default: Getting Attention only with a real signal.
    expect(
      legacyRatingLabel({
        lifecycleState: 'gathering_attention',
        safetyState: 'ok',
        activeAttention: 0.4,
      }),
    ).toBe('getting-attention');
    expect(legacyRatingLabel({ lifecycleState: 'gathering_attention', safetyState: 'ok' })).toBe(
      'new',
    );
    expect(
      legacyRatingLabel({ lifecycleState: 'submitted', safetyState: 'ok', activeAttention: 0 }),
    ).toBe('new');
  });

  it('is total: every lifecycle state yields a value an OLD schema accepts', () => {
    // The pre-redesign client schema is exactly this enum, so every emitted
    // value must be a member (never `well-sourced`, never a new invention).
    for (const lifecycleState of STORY_LIFECYCLE_STATES) {
      for (const safetyState of ['ok', 'caution', 'under-review', 'restricted'] as const) {
        expect(LEGACY_RATING_LABELS).toContain(legacyRatingLabel({ lifecycleState, safetyState }));
      }
    }
  });
});
