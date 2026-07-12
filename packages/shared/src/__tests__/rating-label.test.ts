// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC §5.6 rating-label derivation: proves the priority cascade is correct and
// that ALL SEVEN labels are reachable — including the neutral "New" floor, so the
// default never falsely claims "Getting Attention" for a story nobody has read.
// Also proves the shared safety-state derivation so the surfaces agree.
import { describe, expect, it } from 'vitest';
import {
  RATING_LABEL_KINDS,
  type RatingLabelKind,
  type StorySafetyState,
} from '../schemas/feed.js';
import {
  deriveRatingLabel,
  deriveStorySafetyState,
  type RatingLabelInputs,
} from '../utils/rating-label.js';
import { STORY_LIFECYCLE_STATES } from '../utils/story-lifecycle.js';

/** A baseline input: a fresh, safe, single-lens story that HAS a real
 *  active-reading signal (so the default cascade reads "Getting Attention";
 *  the neutral "New" floor is covered explicitly below). */
function base(overrides: Partial<RatingLabelInputs> = {}): RatingLabelInputs {
  return {
    lifecycleState: 'gathering_attention',
    safetyState: 'ok',
    interpretationsDiverge: false,
    activeAttention: 0.5,
    ...overrides,
  };
}

describe('deriveRatingLabel — lifecycle base mapping', () => {
  it('maps submitted/gathering_attention → getting-attention WHEN there is attention', () => {
    expect(deriveRatingLabel(base({ lifecycleState: 'submitted' }))).toBe('getting-attention');
    expect(deriveRatingLabel(base({ lifecycleState: 'gathering_attention' }))).toBe(
      'getting-attention',
    );
  });

  it('the neutral New floor: the default reads New until a real attention signal arrives (§5.6)', () => {
    // No attention component at all (field OMITTED), or exactly zero ⇒ New,
    // never a false "Getting Attention" (the fold already zeroed idle/bounce).
    expect(
      deriveRatingLabel({
        lifecycleState: 'gathering_attention',
        safetyState: 'ok',
        interpretationsDiverge: false,
      }),
    ).toBe('new');
    expect(deriveRatingLabel(base({ activeAttention: 0 }))).toBe('new');
    // ANY positive genuine attention ⇒ Getting Attention.
    expect(deriveRatingLabel(base({ activeAttention: 0.01 }))).toBe('getting-attention');
    expect(deriveRatingLabel(base({ activeAttention: 0.9 }))).toBe('getting-attention');
    // The attention gate only affects the DEFAULT; a live signal still wins.
    expect(deriveRatingLabel(base({ activeAttention: 0, safetyState: 'under-review' }))).toBe(
      'under-review',
    );
    expect(deriveRatingLabel(base({ activeAttention: 0, lifecycleState: 'deepening' }))).toBe(
      'deepening',
    );
  });

  it('maps deepening → deepening', () => {
    expect(deriveRatingLabel(base({ lifecycleState: 'deepening' }))).toBe('deepening');
  });

  it('maps context_needed → needs-context even without a live SCOI card', () => {
    expect(deriveRatingLabel(base({ lifecycleState: 'context_needed' }))).toBe('needs-context');
  });

  it('maps bridging → bridge-active', () => {
    expect(deriveRatingLabel(base({ lifecycleState: 'bridging' }))).toBe('bridge-active');
  });

  it('maps stable/archived → resolved-context', () => {
    expect(deriveRatingLabel(base({ lifecycleState: 'stable' }))).toBe('resolved-context');
    expect(deriveRatingLabel(base({ lifecycleState: 'archived' }))).toBe('resolved-context');
  });

  it('is total over EVERY lifecycle state (no undefined fall-through)', () => {
    for (const state of STORY_LIFECYCLE_STATES) {
      const label = deriveRatingLabel(base({ lifecycleState: state }));
      expect(RATING_LABEL_KINDS).toContain(label);
    }
  });
});

describe('deriveRatingLabel — live signals', () => {
  it('produces under-review from a safety review posture', () => {
    expect(deriveRatingLabel(base({ safetyState: 'under-review' }))).toBe('under-review');
    expect(deriveRatingLabel(base({ safetyState: 'restricted' }))).toBe('under-review');
  });

  it('produces needs-context from a live SCOI divergence card', () => {
    expect(deriveRatingLabel(base({ interpretationsDiverge: true }))).toBe('needs-context');
  });

  it('reaches ALL SEVEN labels (proves none is dead) ', () => {
    const produced = new Set<RatingLabelKind>([
      deriveRatingLabel(base({ activeAttention: 0 })), // new (the neutral floor)
      deriveRatingLabel(base()), // getting-attention
      deriveRatingLabel(base({ lifecycleState: 'deepening' })), // deepening
      deriveRatingLabel(base({ interpretationsDiverge: true })), // needs-context
      deriveRatingLabel(base({ safetyState: 'under-review' })), // under-review
      deriveRatingLabel(base({ lifecycleState: 'stable' })), // resolved-context
      deriveRatingLabel(base({ lifecycleState: 'bridging' })), // bridge-active
    ]);
    expect([...produced].sort()).toEqual([...RATING_LABEL_KINDS].sort());
  });
});

describe('deriveRatingLabel — cascade priority is load-bearing', () => {
  it('safety review dominates the terminal good states', () => {
    expect(deriveRatingLabel(base({ safetyState: 'under-review', lifecycleState: 'stable' }))).toBe(
      'under-review',
    );
  });

  it('safety review dominates a divergence card', () => {
    expect(
      deriveRatingLabel(base({ safetyState: 'under-review', interpretationsDiverge: true })),
    ).toBe('under-review');
  });

  it('interpretation divergence outranks the lifecycle state (needs-context > deepening)', () => {
    expect(
      deriveRatingLabel(base({ interpretationsDiverge: true, lifecycleState: 'deepening' })),
    ).toBe('needs-context');
  });

  it('bridging outranks deepening-era attention (a story being reconciled reads bridge-active)', () => {
    expect(deriveRatingLabel(base({ lifecycleState: 'bridging', activeAttention: 0.9 }))).toBe(
      'bridge-active',
    );
  });
});

describe('deriveRatingLabel — determinism', () => {
  it('is a pure function (same input → same output)', () => {
    const input = base({ lifecycleState: 'deepening' });
    const first = deriveRatingLabel(input);
    for (let i = 0; i < 50; i += 1) expect(deriveRatingLabel(input)).toBe(first);
  });
});

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

  it('a restricted story still reads under-review as its §5.6 label', () => {
    // The wire posture is `restricted`, but the reader-facing label collapses to
    // the descriptive "Under Review" (the cascade treats both as review).
    const safetyState = deriveStorySafetyState({
      frozen: false,
      mfciRiskState: undefined,
      threadSafetyState: 'restricted',
    });
    expect(deriveRatingLabel(base({ safetyState }))).toBe('under-review');
  });
});
