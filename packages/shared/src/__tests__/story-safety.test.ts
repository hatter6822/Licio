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
  type StorySafetyState,
  storyCorrectionsSchema,
} from '../schemas/feed.js';
import { deriveStorySafetyState } from '../utils/story-safety.js';

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
    // carries neither `sources_count` nor `corrections` (and may still carry the
    // removed `rating_label`, which non-strict parsing drops).
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
    expect('rating_label' in legacy).toBe(false);
  });
});
