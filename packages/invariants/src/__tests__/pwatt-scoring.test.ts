// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PWAtt v0 scoring acceptance + property tests (WS-E.2.1b/c). The two hard
// invariants from the plan are exercised as deterministic properties:
//   • increasing genuine attention/participation never decreases the score;
//   • bounce events and anti-signals never increase it.
import { DWELL_BUCKETS, RETURN_VISIT_BUCKETS } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  type ActorItemSummary,
  actorActiveAttention,
  actorParticipation,
  computePwattV0,
  DEFAULT_ACTIVE_ATTENTION_CONFIG,
  DEFAULT_PARTICIPATION_CONFIG,
  DEFAULT_PWATT_V0_CONFIG,
  DWELL_BUCKET_WEIGHTS,
  itemActiveAttention,
  itemParticipation,
  RETURN_BUCKET_WEIGHTS,
  V0_CONTRIBUTION_WEIGHTS,
  validateActiveAttentionConfig,
  validateParticipationConfig,
  validatePwattV0Config,
} from '../index.js';
import { bool, forAll, int, pick } from './prop.js';

function actor(overrides: Partial<ActorItemSummary> = {}): ActorItemSummary {
  return {
    actor: overrides.actor ?? 'user-1',
    dwellBucket: 'none',
    sourceOpened: false,
    sourceBounceOnly: false,
    contextOpened: false,
    returnVisitBucket: 'none',
    contributions: {},
    uncitedAccusationsByType: {},
    citedContributionsByType: {},
    savedForLater: 0,
    ...overrides,
  };
}

describe('active attention (WS-E.2.1b)', () => {
  it('weights source opens above headline-only reading', () => {
    const headlineOnly = actorActiveAttention(actor({ dwellBucket: 'short' }));
    const withSource = actorActiveAttention(actor({ dwellBucket: 'short', sourceOpened: true }));
    expect(withSource).toBeGreaterThan(headlineOnly);
  });

  it('gives zero source weight to bounce-only opens (clickbait guardrail §5.3)', () => {
    const bounceOnly = actorActiveAttention(actor({ sourceOpened: true, sourceBounceOnly: true }));
    const genuine = actorActiveAttention(actor({ sourceOpened: true }));
    expect(bounceOnly).toBe(0);
    expect(genuine).toBeGreaterThan(0);
  });

  it('filters idle time: none-dwell contributes nothing', () => {
    expect(actorActiveAttention(actor())).toBe(0);
    expect(DWELL_BUCKET_WEIGHTS.none).toBe(0);
  });

  it('rewards nonredundant thread traversal (§5.3 SIG-ATT-TRAVERSE)', () => {
    const noTraversal = actorActiveAttention(actor({ dwellBucket: 'short' }));
    const deepTraversal = actorActiveAttention(
      actor({ dwellBucket: 'short', replyDepthBucket: 'deep' }),
    );
    expect(deepTraversal).toBeGreaterThan(noTraversal);
    // Monotone over the reply-depth buckets.
    const shallow = actorActiveAttention(actor({ replyDepthBucket: 'shallow' }));
    const deep = actorActiveAttention(actor({ replyDepthBucket: 'deep' }));
    expect(deep).toBeGreaterThan(shallow);
    // Absent reply-depth ⇒ no traversal contribution (backward compatible).
    expect(actorActiveAttention(actor({ dwellBucket: 'short' }))).toBe(
      actorActiveAttention(actor({ dwellBucket: 'short', replyDepthBucket: 'none' })),
    );
  });

  it('dwell weights are monotone over the bucket order with ceiling 1 (cap)', () => {
    const weights = DWELL_BUCKETS.map((b) => DWELL_BUCKET_WEIGHTS[b]);
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1] ?? 0);
    }
    expect(Math.max(...weights)).toBe(1);
  });

  it('caps each actor at 1 and keeps the item score in [0, 1)', () => {
    const maxed = actor({
      dwellBucket: 'extended',
      sourceOpened: true,
      contextOpened: true,
      replyDepthBucket: 'deep',
    });
    expect(actorActiveAttention(maxed)).toBe(1);
    const crowd = Array.from({ length: 5_000 }, (_, i) => ({ ...maxed, actor: `u${i}` }));
    const score = itemActiveAttention(crowd);
    expect(score).toBeGreaterThan(0.99);
    expect(score).toBeLessThan(1);
  });

  it('is pure: identical inputs produce identical outputs', () => {
    const input = [
      actor({ dwellBucket: 'medium', sourceOpened: true }),
      actor({ actor: 'user-2', contextOpened: true }),
    ];
    expect(itemActiveAttention(input)).toBe(itemActiveAttention(input));
  });

  it('account-age trust (WS-O.4.5) reduces a fresh-account item vs an aged one', () => {
    const maxed = { dwellBucket: 'extended', sourceOpened: true, contextOpened: true } as const;
    const aged = Array.from({ length: 6 }, (_, i) => actor({ actor: `a${i}`, ...maxed }));
    const fresh = aged.map((a) => ({ ...a, trustWeight: 0.5 }));
    expect(itemActiveAttention(fresh)).toBeLessThan(itemActiveAttention(aged));
    // Absent trustWeight ⇒ full trust (backward compatible).
    expect(itemActiveAttention(aged)).toBe(
      itemActiveAttention(aged.map((a) => ({ ...a, trustWeight: 1 }))),
    );
    // The coarse privacy-bucket actor (anonymity) is never penalized: default 1.
    expect(actor({ ...maxed }).trustWeight).toBeUndefined();
  });

  it('property: scores are always in [0, 1] for random valid inputs', () => {
    forAll(
      101,
      300,
      (rng) =>
        Array.from({ length: int(rng, 0, 12) }, (_, i) =>
          actor({
            actor: `u${i}`,
            dwellBucket: pick(rng, DWELL_BUCKETS),
            sourceOpened: bool(rng),
            sourceBounceOnly: bool(rng),
            contextOpened: bool(rng),
          }),
        ),
      (actors) => {
        const score = itemActiveAttention(actors);
        return (score >= 0 && score <= 1) || `score ${score} out of range`;
      },
    );
  });

  it('property: increasing genuine attention never decreases the score', () => {
    forAll(
      202,
      300,
      (rng) => {
        const base = Array.from({ length: int(rng, 0, 8) }, (_, i) =>
          actor({
            actor: `u${i}`,
            dwellBucket: pick(rng, DWELL_BUCKETS),
            sourceOpened: bool(rng),
            contextOpened: bool(rng),
          }),
        );
        return base;
      },
      (actors) => {
        const before = itemActiveAttention(actors);
        const moreAttention = [
          ...actors,
          actor({ actor: 'new-genuine', dwellBucket: 'long', sourceOpened: true }),
        ];
        const after = itemActiveAttention(moreAttention);
        return after >= before || `adding genuine attention decreased ${before} -> ${after}`;
      },
    );
  });

  it('property: adding bounce-only events never increases the score', () => {
    forAll(
      303,
      300,
      (rng) =>
        Array.from({ length: int(rng, 0, 8) }, (_, i) =>
          actor({
            actor: `u${i}`,
            dwellBucket: pick(rng, DWELL_BUCKETS),
            sourceOpened: bool(rng),
          }),
        ),
      (actors) => {
        const before = itemActiveAttention(actors);
        const withBounce = [
          ...actors,
          actor({ actor: 'bouncer', sourceOpened: true, sourceBounceOnly: true }),
        ];
        const after = itemActiveAttention(withBounce);
        return after <= before || `bounce increased score ${before} -> ${after}`;
      },
    );
  });

  it('rejects invalid configuration at config time', () => {
    expect(() =>
      validateActiveAttentionConfig({
        weights: { dwellPct: 60, sourcePct: 20, contextPct: 10, traversalPct: 10 },
        halfSaturationActors: 8,
      }),
    ).toThrow(/\[1, 50\]/);
    expect(() =>
      validateActiveAttentionConfig({
        weights: { dwellPct: 50, sourcePct: 30, contextPct: 10, traversalPct: 5 },
        halfSaturationActors: 8,
      }),
    ).toThrow(/sum to exactly 100/);
    expect(() => validateActiveAttentionConfig(DEFAULT_ACTIVE_ATTENTION_CONFIG)).not.toThrow();
  });
});

describe('participation (WS-E.2.1c)', () => {
  it('weights return visits with diminishing per-return value', () => {
    // Marginal value per return falls across buckets: 0.5/ret, 0.1/ret, <=0.04/ret.
    expect(RETURN_BUCKET_WEIGHTS.few - RETURN_BUCKET_WEIGHTS.none).toBeGreaterThan(
      RETURN_BUCKET_WEIGHTS.several - RETURN_BUCKET_WEIGHTS.few,
    );
    expect(RETURN_BUCKET_WEIGHTS.several - RETURN_BUCKET_WEIGHTS.few).toBeGreaterThan(
      RETURN_BUCKET_WEIGHTS.many - RETURN_BUCKET_WEIGHTS.several,
    );
    const weights = RETURN_VISIT_BUCKETS.map((b) => RETURN_BUCKET_WEIGHTS[b]);
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1] ?? 0);
    }
  });

  it('gives save-for-later low weight (<= 10% of the participation budget)', () => {
    const saved = actorParticipation(actor({ savedForLater: 1 }));
    expect(saved.value).toBeLessThanOrEqual(0.1);
    expect(saved.value).toBeGreaterThan(0);
  });

  it('gives low_info_reply and flag zero constructive weight', () => {
    expect(V0_CONTRIBUTION_WEIGHTS.low_info_reply).toBe(0);
    expect(V0_CONTRIBUTION_WEIGHTS.flag).toBe(0);
    const lowInfo = actorParticipation(actor({ contributions: { low_info_reply: 4 } }));
    expect(lowInfo.value).toBe(0);
  });

  it('uses uniform v0 weights for constructive types', () => {
    const question = actorParticipation(actor({ contributions: { question: 1 } }));
    const evidence = actorParticipation(actor({ contributions: { evidence: 1 } }));
    expect(question.value).toBe(evidence.value);
    expect(question.value).toBeGreaterThan(0);
  });

  it('dampens rapid repetitive commenting and annotates it (§5.3)', () => {
    const calm = actorParticipation(actor({ contributions: { question: 3 } }));
    const rapid = actorParticipation(actor({ contributions: { question: 9 } }));
    expect(rapid.value).toBeLessThan(calm.value);
    expect(rapid.annotations).toContain('rapid_repetition_dampened');
  });

  it('downweights uncited accusations and annotates (WS-E.2.2b)', () => {
    const cited = actorParticipation(actor({ contributions: { correction: 1 } }));
    const uncited = actorParticipation(
      actor({ contributions: { correction: 1 }, uncitedAccusationsByType: { correction: 1 } }),
    );
    expect(uncited.value).toBeLessThan(cited.value);
    expect(uncited.annotations).toContain('source_free_accusation_downweight');
    // The same accusation WITH evidence is not downweighted.
    expect(cited.annotations).not.toContain('source_free_accusation_downweight');
  });

  it('applies the v0 coordinated-burst placeholder dampening at item level', () => {
    const actors = [actor({ contributions: { question: 2 } })];
    const clean = itemParticipation(actors, {});
    const burst = itemParticipation(actors, { coordinatedBurst: { confidence: 0.9 } });
    expect(burst.value).toBeLessThan(clean.value);
    expect(burst.annotations).toContain('coordinated_burst_placeholder_dampening');
  });

  it('account-age trust (WS-O.4.5) scales only the ITEM sum, not the per-actor record', () => {
    const aged = Array.from({ length: 4 }, (_, i) =>
      actor({ actor: `a${i}`, contributions: { evidence: 2 }, returnVisitBucket: 'several' }),
    );
    const fresh = aged.map((a) => ({ ...a, trustWeight: 0.5 }));
    const agedItem = itemParticipation(aged, {});
    const freshItem = itemParticipation(fresh, {});
    expect(freshItem.value).toBeLessThan(agedItem.value);
    // The per-actor ledger record stays UNWEIGHTED (the user's honest signal).
    expect(freshItem.perActor.get('a0')?.value).toBe(agedItem.perActor.get('a0')?.value);
  });

  it('property: constructive contributions always increase the score up to the cap', () => {
    // Domain: the NON-anti-signal regime (count + 1 stays at/below the rapid
    // threshold). Beyond it the §5.3 rapid-repetition anti-signal MUST dampen
    // the score — that mandated interaction is asserted separately below.
    const rapidThreshold = DEFAULT_PARTICIPATION_CONFIG.rapidThreshold;
    forAll(
      404,
      300,
      (rng) => ({
        count: int(rng, 0, rapidThreshold - 1),
        type: pick(rng, ['question', 'evidence', 'correction', 'synthesis'] as const),
      }),
      ({ count, type }) => {
        const before = actorParticipation(actor({ contributions: { [type]: count } })).value;
        const after = actorParticipation(actor({ contributions: { [type]: count + 1 } })).value;
        if (before < 0.5) {
          // 0.5 == the contribution dimension's full budget (50%).
          return after > before || `constructive ${type} did not increase ${before} -> ${after}`;
        }
        return after >= before || `constructive ${type} decreased ${before} -> ${after}`;
      },
    );
  });

  it('crossing the rapid threshold dampens rather than rewards (anti-signal dominance)', () => {
    const atThreshold = actorParticipation(
      actor({ contributions: { question: DEFAULT_PARTICIPATION_CONFIG.rapidThreshold } }),
    );
    const beyond = actorParticipation(
      actor({ contributions: { question: DEFAULT_PARTICIPATION_CONFIG.rapidThreshold + 1 } }),
    );
    expect(beyond.value).toBeLessThan(atThreshold.value);
    expect(beyond.annotations).toContain('rapid_repetition_dampened');
  });

  it('property: anti-signals never increase the score', () => {
    forAll(
      505,
      300,
      (rng) => ({
        questions: int(rng, 0, 8),
        lowInfo: int(rng, 1, 6),
        returns: pick(rng, RETURN_VISIT_BUCKETS),
      }),
      ({ questions, lowInfo, returns }) => {
        const base = actor({ contributions: { question: questions }, returnVisitBucket: returns });
        const before = actorParticipation(base).value;
        const after = actorParticipation({
          ...base,
          contributions: { question: questions, low_info_reply: lowInfo },
        }).value;
        return after <= before || `low-info replies increased score ${before} -> ${after}`;
      },
    );
  });

  it('rejects invalid configuration at config time', () => {
    expect(() =>
      validateParticipationConfig({
        ...DEFAULT_PARTICIPATION_CONFIG,
        weights: { returnPct: 51, savePct: 9, contributionPct: 40 },
      }),
    ).toThrow(/\[1, 50\]/);
    expect(() =>
      validateParticipationConfig({ ...DEFAULT_PARTICIPATION_CONFIG, rapidDampening: 1.5 }),
    ).toThrow(/\[0, 1\]/);
    expect(() => validateParticipationConfig(DEFAULT_PARTICIPATION_CONFIG)).not.toThrow();
  });
});

describe('PWAtt v0 (WS-E.2.1)', () => {
  it('combines components into a [0, 1] score with per-actor breakdowns', () => {
    const result = computePwattV0({
      itemId: 'item-1',
      actors: [
        actor({
          actor: 'reader',
          dwellBucket: 'medium',
          sourceOpened: true,
          returnVisitBucket: 'few',
        }),
        actor({ actor: 'contributor', contributions: { question: 1 } }),
      ],
      antiSignals: {},
    });
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.actorBreakdowns).toHaveLength(2);
    expect(result.actorBreakdowns[0]?.activeAttention).toBeGreaterThan(0);
  });

  it('is reproducible (purity, WS-E.2.1e prerequisite)', () => {
    const input = {
      itemId: 'item-1',
      actors: [actor({ dwellBucket: 'long', sourceOpened: true })],
      antiSignals: {},
    };
    expect(computePwattV0(input)).toEqual(computePwattV0(input));
  });

  it('confidence grows with distinct actors', () => {
    const one = computePwattV0({ itemId: 'i', actors: [actor()], antiSignals: {} });
    const five = computePwattV0({
      itemId: 'i',
      actors: Array.from({ length: 5 }, (_, i) => actor({ actor: `u${i}` })),
      antiSignals: {},
    });
    expect(five.confidence).toBeGreaterThan(one.confidence);
  });

  it('validates the composed config', () => {
    expect(() => validatePwattV0Config(DEFAULT_PWATT_V0_CONFIG)).not.toThrow();
    expect(() =>
      validatePwattV0Config({ ...DEFAULT_PWATT_V0_CONFIG, confidenceHalfSaturation: 0 }),
    ).toThrow(/confidenceHalfSaturation/);
  });
});
