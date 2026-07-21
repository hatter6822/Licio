// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Behavioral-authenticity mathematics (bot-prevention layer 2): evidence
// gating, the three component tells (variety / breadth / rhythm), the
// duplication collapse, composition bounds, and the neutrality obligation
// (identical behavior ⇒ identical score) — deterministic property runs via
// the seeded harness.

import type { DwellBucket } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  type ActorBehaviorWindow,
  assessAuthenticity,
  BEHAVIOR_STREAM_VERSION,
  behaviorStreamText,
  DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG,
  duplicationFactor,
  dwellVarietyScore,
  effectiveAuthenticity,
  interactionBreadthScore,
  normalizedEntropy,
  temporalRhythmScore,
} from '../behavior/index.js';
import { estimateJaccard, minhashSignature } from '../text/index.js';
import { forAll, int, pick } from './prop.js';

const CONFIG = DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG;

/** A window at hour `h` (from a fixed epoch) with overridable fields. */
function windowAt(h: number, overrides: Partial<ActorBehaviorWindow> = {}): ActorBehaviorWindow {
  return {
    windowStart: new Date(Date.UTC(2026, 5, 1) + h * 3_600_000).toISOString(),
    eventCount: 4,
    itemsTouched: 3,
    dwellHistogram: { short: 2, medium: 1 },
    replyDepthHistogram: {},
    returnHistogram: {},
    sourceOpens: 0,
    contextOpens: 0,
    saves: 0,
    contributions: 0,
    ...overrides,
  };
}

/** A plausibly-human stream: bursty hours, varied dwell, mixed dimensions. */
function humanWindows(count: number): ActorBehaviorWindow[] {
  const dwellMix: Array<Partial<Record<DwellBucket, number>>> = [
    { glance: 3, short: 1 },
    { short: 2, medium: 2 },
    { medium: 1, long: 1 },
    { glance: 1, extended: 1 },
  ];
  return Array.from({ length: count }, (_, i) =>
    windowAt(i * 5 + (i % 3), {
      eventCount: 2 + (i % 5) * 3,
      dwellHistogram: dwellMix[i % dwellMix.length] as Partial<Record<DwellBucket, number>>,
      sourceOpens: i % 4 === 0 ? 1 : 0,
      contextOpens: i % 6 === 0 ? 1 : 0,
      contributions: i % 7 === 0 ? 1 : 0,
      returnHistogram: i % 5 === 0 ? { few: 1 } : {},
    }),
  );
}

/** A degenerate bot stream: every hour active, constant volume, one bucket. */
function botWindows(count: number): ActorBehaviorWindow[] {
  return Array.from({ length: count }, (_, i) =>
    windowAt(i, {
      eventCount: 12,
      itemsTouched: 12,
      dwellHistogram: { extended: 12 },
    }),
  );
}

describe('normalizedEntropy', () => {
  it('is 0 for degenerate, 1 for uniform, and always in [0, 1]', () => {
    expect(normalizedEntropy([10, 0, 0, 0, 0], 5)).toBe(0);
    expect(normalizedEntropy([7, 7, 7, 7, 7], 5)).toBeCloseTo(1, 10);
    forAll(
      41,
      300,
      (rng) => Array.from({ length: 5 }, () => int(rng, 0, 50)),
      (counts) => {
        const h = normalizedEntropy(counts, 5);
        return (h >= 0 && h <= 1) || `entropy ${h} out of range`;
      },
    );
  });
});

describe('dwellVarietyScore', () => {
  it('is NEUTRAL below the evidence floor (a lurker is never damped)', () => {
    const sparse = [windowAt(0, { dwellHistogram: { extended: 3 } })];
    expect(dwellVarietyScore(sparse, CONFIG)).toMatchObject({ score: 1, flagged: false });
  });

  it('damps a high-volume single-bucket stream and clears a varied one', () => {
    const bot = dwellVarietyScore(botWindows(20), CONFIG);
    expect(bot.flagged).toBe(true);
    expect(bot.score).toBe(CONFIG.componentFloor);
    const human = dwellVarietyScore(humanWindows(30), CONFIG);
    expect(human.flagged).toBe(false);
    expect(human.score).toBe(1);
  });

  it('never leaves [componentFloor, 1] (total, bounded)', () => {
    forAll(
      42,
      200,
      (rng) =>
        Array.from({ length: int(rng, 0, 30) }, (_, i) =>
          windowAt(i, {
            eventCount: int(rng, 0, 20),
            dwellHistogram: {
              [pick(rng, ['glance', 'short', 'medium', 'long', 'extended'] as const)]: int(
                rng,
                0,
                20,
              ),
            },
          }),
        ),
      (windows) => {
        const { score } = dwellVarietyScore(windows, CONFIG);
        return (
          (score >= CONFIG.componentFloor && score <= 1) || `variety score ${score} out of bounds`
        );
      },
    );
  });
});

describe('interactionBreadthScore', () => {
  it('is NEUTRAL below the evidence floor', () => {
    expect(interactionBreadthScore([windowAt(0)], CONFIG).score).toBe(1);
  });

  it('damps a high-volume single-dimension stream, clears a broad one', () => {
    const oneTrick = interactionBreadthScore(botWindows(20), CONFIG);
    expect(oneTrick.flagged).toBe(true);
    expect(oneTrick.score).toBeLessThan(1);
    const broad = interactionBreadthScore(humanWindows(30), CONFIG);
    expect(broad.score).toBe(1);
  });
});

describe('temporalRhythmScore', () => {
  it('is NEUTRAL below the active-window floor', () => {
    expect(temporalRhythmScore(humanWindows(10), CONFIG).score).toBe(1);
  });

  it('flags 24/7 metronomic activity and clears bursty human rhythm', () => {
    const machine = temporalRhythmScore(botWindows(72), CONFIG);
    expect(machine.flagged).toBe(true);
    expect(machine.score).toBe(CONFIG.componentFloor);
    // Human: active ~1 hour in 5, volume varies 2..14 → both tells stay quiet.
    const human = temporalRhythmScore(humanWindows(60), CONFIG);
    expect(human.flagged).toBe(false);
  });
});

describe('assessAuthenticity (composition)', () => {
  it('is exactly neutral (1) for an empty history', () => {
    const assessment = assessAuthenticity([], CONFIG);
    expect(assessment.coherence).toBe(1);
    expect(assessment.flags).toEqual([]);
  });

  it('is the floored MINIMUM of the components, with machine flags named', () => {
    const assessment = assessAuthenticity(botWindows(72), CONFIG);
    expect(assessment.coherence).toBe(CONFIG.componentFloor);
    expect(assessment.flags).toEqual(
      expect.arrayContaining(['dwell_variety', 'interaction_breadth', 'temporal_rhythm']),
    );
  });

  it('clears a plausibly-human stream at full weight', () => {
    const assessment = assessAuthenticity(humanWindows(80), CONFIG);
    expect(assessment.coherence).toBe(1);
    expect(assessment.flags).toEqual([]);
  });

  it('NEUTRALITY: identical histories yield identical assessments', () => {
    const a = assessAuthenticity(humanWindows(50), CONFIG);
    const b = assessAuthenticity(humanWindows(50), CONFIG);
    expect(a).toEqual(b);
  });

  it('stays within [componentFloor, 1] over random histories (total)', () => {
    forAll(
      7,
      150,
      (rng) =>
        Array.from({ length: int(rng, 0, 100) }, (_, i) =>
          windowAt(i * int(rng, 1, 3), {
            eventCount: int(rng, 0, 30),
            itemsTouched: int(rng, 0, 20),
            dwellHistogram: { short: int(rng, 0, 10), long: int(rng, 0, 5) },
            sourceOpens: int(rng, 0, 3),
            contributions: int(rng, 0, 2),
          }),
        ),
      (windows) => {
        const { coherence } = assessAuthenticity(windows, CONFIG);
        return (
          (coherence >= CONFIG.componentFloor && coherence <= 1) ||
          `coherence ${coherence} out of bounds`
        );
      },
    );
  });
});

describe('behavior-stream duplication (MinHash reuse)', () => {
  it('two accounts running the SAME script are near-duplicates; a human is not', () => {
    const script = botWindows(60);
    const cloneA = minhashSignature(behaviorStreamText(script));
    const cloneB = minhashSignature(behaviorStreamText(botWindows(60)));
    const human = minhashSignature(behaviorStreamText(humanWindows(60)));
    expect(estimateJaccard(cloneA, cloneB)).toBeGreaterThanOrEqual(CONFIG.duplicationJaccard);
    expect(estimateJaccard(cloneA, human)).toBeLessThan(CONFIG.duplicationJaccard);
  });

  it('the stream text is versioned and deterministic under window reordering', () => {
    const windows = humanWindows(10);
    const shuffled = [...windows].reverse();
    expect(behaviorStreamText(windows)).toBe(behaviorStreamText(shuffled));
    expect(behaviorStreamText(windows).startsWith(BEHAVIOR_STREAM_VERSION)).toBe(true);
  });
});

describe('duplicationFactor + effectiveAuthenticity', () => {
  it('collapses k clones to ~one account of influence, floored', () => {
    expect(duplicationFactor(1, CONFIG)).toBe(1);
    expect(duplicationFactor(2, CONFIG)).toBe(1); // below minClusterSize
    expect(duplicationFactor(4, CONFIG)).toBe(0.25);
    expect(duplicationFactor(100, CONFIG)).toBe(CONFIG.duplicationFloor);
    // k members × the per-member factor ≈ one account (until the floor bites).
    expect(4 * duplicationFactor(4, CONFIG)).toBe(1);
  });

  it('never returns an effective multiplier of zero (influence, not silence)', () => {
    forAll(
      11,
      200,
      (rng) => ({ coherence: rng(), cluster: int(rng, 1, 500) }),
      ({ coherence, cluster }) => {
        const effective = effectiveAuthenticity(coherence, cluster, CONFIG);
        return (
          (effective >= CONFIG.overallFloor && effective <= 1) ||
          `effective ${effective} out of bounds`
        );
      },
    );
  });
});
