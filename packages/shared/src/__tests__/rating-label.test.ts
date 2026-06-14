// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC §5.6 rating-label derivation: proves the priority cascade is correct and
// that ALL SEVEN labels are reachable (the bug this fixed: only five were
// producible, so every story read "Getting Attention"). Also proves the shared
// safety-state derivation so the feed and story-detail surfaces agree.
import { describe, expect, it } from 'vitest';
import {
  RATING_LABEL_KINDS,
  type RatingLabelKind,
  type StorySafetyState,
} from '../schemas/feed.js';
import type { MeriExposureLabelWire } from '../schemas/invariants-api.js';
import {
  deriveRatingLabel,
  deriveStorySafetyState,
  meriExposureIsIndependent,
  type RatingLabelInputs,
  WELL_SOURCED_MIN_EVIDENCE_CARDS,
} from '../utils/rating-label.js';
import { STORY_LIFECYCLE_STATES } from '../utils/story-lifecycle.js';

/** A baseline input: a fresh, safe, single-lens, evidence-free story. */
function base(overrides: Partial<RatingLabelInputs> = {}): RatingLabelInputs {
  return {
    lifecycleState: 'gathering_attention',
    safetyState: 'ok',
    interpretationsDiverge: false,
    evidenceCount: 0,
    meriExposure: null,
    ...overrides,
  };
}

describe('deriveRatingLabel — lifecycle base mapping', () => {
  it('maps submitted/gathering_attention → getting-attention (the default)', () => {
    expect(deriveRatingLabel(base({ lifecycleState: 'submitted' }))).toBe('getting-attention');
    expect(deriveRatingLabel(base({ lifecycleState: 'gathering_attention' }))).toBe(
      'getting-attention',
    );
  });

  it('maps deepening → deepening (no strong evidence)', () => {
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

describe('deriveRatingLabel — live signals (the previously unreachable labels)', () => {
  it('produces well-sourced from ≥2 evidence cards + MERI independence', () => {
    expect(
      deriveRatingLabel(
        base({
          lifecycleState: 'gathering_attention',
          evidenceCount: WELL_SOURCED_MIN_EVIDENCE_CARDS,
          meriExposure: 'independent_source',
        }),
      ),
    ).toBe('well-sourced');
    expect(
      deriveRatingLabel(
        base({ lifecycleState: 'deepening', evidenceCount: 3, meriExposure: 'new_angle' }),
      ),
    ).toBe('well-sourced');
  });

  it('produces under-review from a safety review posture', () => {
    expect(deriveRatingLabel(base({ safetyState: 'under-review' }))).toBe('under-review');
    expect(deriveRatingLabel(base({ safetyState: 'restricted' }))).toBe('under-review');
  });

  it('produces needs-context from a live SCOI divergence card', () => {
    expect(deriveRatingLabel(base({ interpretationsDiverge: true }))).toBe('needs-context');
  });

  it('reaches ALL SEVEN labels (proves none is dead) ', () => {
    const produced = new Set<RatingLabelKind>([
      deriveRatingLabel(base()), // getting-attention
      deriveRatingLabel(base({ lifecycleState: 'deepening' })), // deepening
      deriveRatingLabel(base({ evidenceCount: 2, meriExposure: 'independent_source' })), // well-sourced
      deriveRatingLabel(base({ interpretationsDiverge: true })), // needs-context
      deriveRatingLabel(base({ safetyState: 'under-review' })), // under-review
      deriveRatingLabel(base({ lifecycleState: 'stable' })), // resolved-context
      deriveRatingLabel(base({ lifecycleState: 'bridging' })), // bridge-active
    ]);
    expect([...produced].sort()).toEqual([...RATING_LABEL_KINDS].sort());
  });
});

describe('deriveRatingLabel — cascade priority is load-bearing', () => {
  it('safety review dominates strong evidence (never well-sourced under review)', () => {
    expect(
      deriveRatingLabel(
        base({
          safetyState: 'under-review',
          evidenceCount: 10,
          meriExposure: 'independent_source',
          lifecycleState: 'stable',
        }),
      ),
    ).toBe('under-review');
  });

  it('safety review dominates a divergence card', () => {
    expect(
      deriveRatingLabel(base({ safetyState: 'under-review', interpretationsDiverge: true })),
    ).toBe('under-review');
  });

  it('interpretation divergence outranks strong evidence (needs-context > well-sourced)', () => {
    expect(
      deriveRatingLabel(
        base({
          interpretationsDiverge: true,
          evidenceCount: 5,
          meriExposure: 'independent_source',
        }),
      ),
    ).toBe('needs-context');
  });

  it('bridging outranks evidence (a story being reconciled reads bridge-active)', () => {
    expect(
      deriveRatingLabel(
        base({ lifecycleState: 'bridging', evidenceCount: 5, meriExposure: 'independent_source' }),
      ),
    ).toBe('bridge-active');
  });

  it('resolved (stable) outranks evidence (terminal synthesis reads resolved-context)', () => {
    expect(
      deriveRatingLabel(
        base({ lifecycleState: 'stable', evidenceCount: 5, meriExposure: 'independent_source' }),
      ),
    ).toBe('resolved-context');
  });

  it('well-sourced upgrades the active states past deepening/getting-attention', () => {
    // Same evidence, two active lifecycle states → both upgrade to well-sourced.
    for (const state of ['submitted', 'gathering_attention', 'deepening'] as const) {
      expect(
        deriveRatingLabel(
          base({ lifecycleState: state, evidenceCount: 4, meriExposure: 'independent_source' }),
        ),
      ).toBe('well-sourced');
    }
  });
});

describe('deriveRatingLabel — well-sourced gating is honest', () => {
  it('does NOT fire below the evidence-card minimum', () => {
    expect(
      deriveRatingLabel(
        base({
          evidenceCount: WELL_SOURCED_MIN_EVIDENCE_CARDS - 1,
          meriExposure: 'independent_source',
        }),
      ),
    ).toBe('getting-attention');
  });

  it('does NOT fire without MERI-verified independence (honest absence)', () => {
    // Plenty of evidence, but MERI has not run (null) → not yet "well-sourced".
    expect(deriveRatingLabel(base({ evidenceCount: 9, meriExposure: null }))).toBe(
      'getting-attention',
    );
    // Evidence present but MERI says the coverage is redundant → not independent.
    for (const weak of ['same_claim_new_evidence', 'duplicate_context'] as const) {
      expect(deriveRatingLabel(base({ evidenceCount: 9, meriExposure: weak }))).toBe(
        'getting-attention',
      );
    }
  });

  it('meriExposureIsIndependent recognises exactly the independent classes', () => {
    const independent: MeriExposureLabelWire[] = ['independent_source', 'new_angle'];
    const dependent: (MeriExposureLabelWire | null)[] = [
      'same_claim_new_evidence',
      'duplicate_context',
      null,
    ];
    for (const label of independent) expect(meriExposureIsIndependent(label)).toBe(true);
    for (const label of dependent) expect(meriExposureIsIndependent(label)).toBe(false);
  });
});

describe('deriveRatingLabel — determinism', () => {
  it('is a pure function (same input → same output)', () => {
    const input = base({
      lifecycleState: 'deepening',
      evidenceCount: 2,
      meriExposure: 'new_angle',
    });
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
});
