// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Integrated v1 component computation (WS-E.2.3a + WS-E.2.3b in the live
// path): the contribution hierarchy measurably affects component output,
// per-user saturation diminishes repeated same-type volume, the 50% dominance
// cap holds at the item level for any input volume, and the config validator
// rejects every malformed parameter.
import { describe, expect, it } from 'vitest';
import {
  type ActorItemSummary,
  actorV1Contribution,
  antiSignalAttenuation,
  computePwattV0,
  computePwattV1Components,
  DEFAULT_ANTI_SIGNAL_ATTENUATION,
  DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
  type ItemAntiSignals,
  PWATT_V0_VERSION,
  PWATT_V1_VERSION,
  V1_CONTRIBUTION_WEIGHTS,
  validateAntiSignalAttenuation,
  validatePwattV1ComponentsConfig,
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

describe('actorV1Contribution (hierarchy + per-user saturation)', () => {
  it('the hierarchy affects output: correction > explanation', () => {
    const order = ['correction', 'explanation'] as const;
    const values = order.map(
      (type) => actorV1Contribution(actor({ contributions: { [type]: 1 } })).value,
    );
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i - 1]).toBeGreaterThan(values[i] ?? Number.POSITIVE_INFINITY);
    }
    expect(actorV1Contribution(actor({ contributions: { low_info_reply: 5 } })).value).toBe(0);
  });

  it('WS-T — a SOURCED contribution outscores an identical UNSOURCED one', () => {
    const unsourced = actorV1Contribution(actor({ contributions: { explanation: 1 } }));
    const sourced = actorV1Contribution(
      actor({
        contributions: { explanation: 1 },
        citedContributionsByType: { explanation: 1 },
      }),
    );
    expect(sourced.value).toBeGreaterThan(unsourced.value);
    expect(sourced.annotations).toContain('sourced_contribution_weighted');
    expect(unsourced.annotations).not.toContain('sourced_contribution_weighted');
  });

  it('the stored implementation version moved with the formula', () => {
    // The invariant store's conflict key includes this string and `upsert`
    // updates on conflict, so shipping the sourced-contribution bonus under an
    // unchanged `v1` would let a reprocessed pre-deploy window OVERWRITE its
    // historical row with values the old algorithm never produced — losing the
    // comparison and the audit reproducibility with no trace that it happened.
    // This assertion is the gate: change the scoring above, and it fails until
    // the version moves too.
    expect(PWATT_V1_VERSION).toBe('v1.1');
    expect(PWATT_V1_VERSION).not.toBe(PWATT_V0_VERSION);
  });

  it('…and so did the V0 version, because the same bonus moved the v0 formula', () => {
    // The bonus landed in `participation.ts`'s `actorParticipation`, which is the
    // v0 path (`v0.ts` folds `itemParticipation` into `participation` and then
    // into `score`), and `apps/api` upserts that row under ('PWAtt_v0', …,
    // PWATT_V0_VERSION).  Both stored rows changed; only one version string did,
    // so the v0 row was the one silently overwritten on reprocessing.
    //
    // Tied to the BEHAVIOUR, not just the literal: the pin is only meaningful
    // while the v0 score actually responds to citations.
    const base = { correction: 2 } as const;
    const v0Input = (overrides: Partial<ActorItemSummary>) => ({
      itemId: 'item-1',
      actors: [actor(overrides)],
      antiSignals: {},
    });
    const uncited = computePwattV0(v0Input({ contributions: base }));
    const cited = computePwattV0(v0Input({ contributions: base, citedContributionsByType: base }));
    expect(cited.participation).toBeGreaterThan(uncited.participation);
    expect(cited.score).toBeGreaterThan(uncited.score);
    expect(PWATT_V0_VERSION).toBe('v0.1');
  });

  it('per-user saturation: the Nth same-type contribution adds less than the (N-1)th', () => {
    const value = (n: number) =>
      actorV1Contribution(actor({ contributions: { correction: n } })).value;
    const m1 = value(1) - value(0);
    const m2 = value(2) - value(1);
    const m3 = value(3) - value(2);
    expect(m1).toBeGreaterThan(m2);
    expect(m2).toBeGreaterThan(m3);
  });

  it('downweights an uncited accusation at its own type weight; a citation restores it', () => {
    const cited = actorV1Contribution(actor({ contributions: { correction: 1 } }));
    const uncited = actorV1Contribution(
      actor({
        contributions: { correction: 1 },
        uncitedAccusationsByType: { correction: 1 },
      }),
    );
    expect(uncited.value).toBeLessThan(cited.value);
    expect(uncited.value).toBeGreaterThan(0); // downweighted, never zeroed
    expect(uncited.annotations).toContain('source_free_accusation_downweight');
    // The downweight scales with the accusing type's hierarchy weight.
    const uncitedExplanation = actorV1Contribution(
      actor({
        contributions: { explanation: 1 },
        uncitedAccusationsByType: { explanation: 1 },
      }),
    );
    const lossCorrection = cited.value - uncited.value;
    const lossExplanation =
      actorV1Contribution(actor({ contributions: { explanation: 1 } })).value -
      uncitedExplanation.value;
    expect(lossCorrection).toBeGreaterThan(lossExplanation);
  });

  it('dampens rapid repetition and never rewards low-info volume', () => {
    const calm = actorV1Contribution(actor({ contributions: { explanation: 3 } }));
    const rapid = actorV1Contribution(actor({ contributions: { explanation: 9 } }));
    expect(rapid.value).toBeLessThan(calm.value);
    expect(rapid.annotations).toContain('rapid_repetition_dampened');
  });

  it('property: adding any contribution never lowers the pre-dampening score', () => {
    const types = ['correction', 'explanation', 'bridge_comment'] as const;
    forAll(
      1101,
      300,
      (rng) => ({
        base: int(rng, 0, 3),
        type: pick(rng, types),
        extra: pick(rng, types),
      }),
      ({ base, type, extra }) => {
        const before = actorV1Contribution(actor({ contributions: { [type]: base } }), {
          ...DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
          rapidThreshold: 1_000,
        }).value;
        const counts: Partial<Record<(typeof types)[number], number>> = { [type]: base };
        counts[extra] = (counts[extra] ?? 0) + 1;
        const after = actorV1Contribution(actor({ contributions: counts }), {
          ...DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
          rapidThreshold: 1_000,
        }).value;
        return after >= before || `adding ${extra} decreased ${before} -> ${after}`;
      },
    );
  });

  it('property: the citation bonus keeps the score monotone at ANY saturation point', () => {
    // The regression this pins: while the bonus multiplier read the sourced
    // FRACTION (`cited / n`), an uncited contribution added to an already-
    // SATURATED per-type value strictly LOWERED the actor's score — inside the
    // window the docstring guarantees monotone.  Two configs reach that regime
    // and are both schema-legal + runtime-settable through `pwatt_config`:
    // a saturation point at or below `rapidThreshold`, and the `sigmoid` curve,
    // which has no saturation point for a config validator to reject at all.
    const curves = [
      { kind: 'logarithmic' as const, scale: 1, saturationPoint: 2 },
      { kind: 'logarithmic' as const, scale: 1, saturationPoint: 6 },
      { kind: 'sigmoid' as const, scale: 1 },
    ];
    const types = ['correction', 'explanation', 'bridge_comment'] as const;
    for (const contributionCurve of curves) {
      // rapidThreshold far above the enumerated counts: the guarantee is
      // explicitly scoped to totalContributions <= rapidThreshold, above which
      // the §5.3 rapid-repetition dampening deliberately drops the value.
      const config = {
        ...DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
        contributionCurve,
        rapidThreshold: 1_000,
      };
      const score = (type: (typeof types)[number], n: number, cited: number, uncited: number) =>
        actorV1Contribution(
          actor({
            contributions: { [type]: n },
            citedContributionsByType: { [type]: cited },
            uncitedAccusationsByType: { [type]: uncited },
          }),
          config,
        ).value;
      for (const type of types) {
        for (let n = 0; n <= 8; n += 1) {
          for (let cited = 0; cited <= n; cited += 1) {
            for (let uncited = 0; cited + uncited <= n; uncited += 1) {
              const where = `${contributionCurve.kind} ${type} n=${n} cited=${cited} uncited=${uncited}`;
              const before = score(type, n, cited, uncited);
              // One more UNSOURCED contribution — the case the fraction broke.
              expect(score(type, n + 1, cited, uncited), where).toBeGreaterThanOrEqual(before);
              // One more SOURCED contribution.
              expect(score(type, n + 1, cited + 1, uncited), where).toBeGreaterThanOrEqual(before);
              // The WS-E.2.2b transparency remedy: sourcing an accusation.
              if (uncited > 0) {
                expect(score(type, n, cited + 1, uncited - 1), where).toBeGreaterThanOrEqual(
                  before,
                );
              }
            }
          }
        }
      }
    }
  });

  it('a saturated per-type value is not lowered by an uncited contribution', () => {
    // The reported instance, verbatim: saturationPoint 2 sits BELOW the
    // rapidThreshold of 5, so `correction` saturates at n=2 while the
    // documented monotone window runs to n=5.
    const config = {
      ...DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
      contributionCurve: { kind: 'logarithmic' as const, scale: 1, saturationPoint: 2 },
      rapidThreshold: 5,
    };
    const value = (n: number) =>
      actorV1Contribution(
        actor({
          contributions: { correction: n },
          citedContributionsByType: { correction: 1 },
        }),
        config,
      ).value;
    expect(value(4)).toBeGreaterThanOrEqual(value(3));
    expect(value(5)).toBeGreaterThanOrEqual(value(4));
  });
});

describe('computePwattV1Components (item-level dominance cap)', () => {
  it('produces [0, 1] components with per-dimension breakdowns', () => {
    const components = computePwattV1Components([
      actor({
        dwellBucket: 'long',
        sourceOpened: true,
        contextOpened: true,
        returnVisitBucket: 'few',
        contributions: { correction: 2 },
      }),
      actor({ actor: 'user-2', dwellBucket: 'short' }),
    ]);
    expect(components.activeAttention).toBeGreaterThan(0);
    expect(components.activeAttention).toBeLessThanOrEqual(1);
    expect(components.participation).toBeGreaterThan(0);
    expect(components.participation).toBeLessThanOrEqual(1);
    expect(Object.keys(components.attentionDimensions).sort()).toEqual([
      'context',
      'dwell',
      'source',
      'traversal',
    ]);
  });

  it('a bounce-only source open contributes zero to the source dimension', () => {
    const withBounce = computePwattV1Components([
      actor({ sourceOpened: true, sourceBounceOnly: true }),
    ]);
    expect(withBounce.attentionDimensions['source']).toBe(0);
  });

  it('property: no dimension ever exceeds 50% of the component budget', () => {
    forAll(
      1202,
      200,
      (rng) =>
        Array.from({ length: int(rng, 1, 40) }, (_, i) =>
          actor({
            actor: `u${i}`,
            dwellBucket: pick(rng, [
              'none',
              'glance',
              'short',
              'medium',
              'long',
              'extended',
            ] as const),
            sourceOpened: bool(rng),
            contextOpened: bool(rng),
            returnVisitBucket: pick(rng, ['none', 'few', 'several', 'many'] as const),
            contributions: { correction: int(rng, 0, 50), low_info_reply: int(rng, 0, 50) },
          }),
        ),
      (actors) => {
        const components = computePwattV1Components(actors);
        for (const [name, value] of [
          ...Object.entries(components.attentionDimensions),
          ...Object.entries(components.participationDimensions),
        ]) {
          if (value > 0.5 + 1e-12) return `${name} exceeded the 50% cap: ${value}`;
        }
        return (
          (components.activeAttention <= 1 && components.participation <= 1) ||
          'component exceeded 1'
        );
      },
    );
  });

  it('collects per-actor annotations for ledger parity', () => {
    const components = computePwattV1Components([
      actor({
        actor: 'accuser',
        contributions: { correction: 1 },
        uncitedAccusationsByType: { correction: 1 },
      }),
    ]);
    expect(components.actorAnnotations.get('accuser')).toContain(
      'source_free_accusation_downweight',
    );
  });
});

describe('validatePwattV1ComponentsConfig (config-time rejection)', () => {
  it('accepts the reviewed defaults', () => {
    expect(() => validatePwattV1ComponentsConfig(DEFAULT_PWATT_V1_COMPONENTS_CONFIG)).not.toThrow();
  });

  it('rejects a broken hierarchy, bad dimensions, and out-of-range factors', () => {
    expect(() =>
      validatePwattV1ComponentsConfig({
        ...DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
        contributionWeights: { ...V1_CONTRIBUTION_WEIGHTS, low_info_reply: 0.5 },
      }),
    ).toThrow(/low_info_reply/);
    expect(() =>
      validatePwattV1ComponentsConfig({
        ...DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
        attentionDimensions: {
          dwell: { weightPct: 60, curve: { kind: 'sigmoid', scale: 4 } },
          source: { weightPct: 20, curve: { kind: 'sigmoid', scale: 4 } },
          context: { weightPct: 10, curve: { kind: 'sigmoid', scale: 4 } },
          traversal: { weightPct: 10, curve: { kind: 'sigmoid', scale: 4 } },
        },
      }),
    ).toThrow(/dominance cap/);
    expect(() =>
      validatePwattV1ComponentsConfig({
        ...DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
        rapidDampening: 1.2,
      }),
    ).toThrow(/\[0, 1\]/);
  });

  it('rejects an out-of-range anti-signal attenuation factor', () => {
    expect(() =>
      validatePwattV1ComponentsConfig({
        ...DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
        antiSignalAttenuation: { coordinatedBurstMax: 1.5, harassmentCascade: 0.3 },
      }),
    ).toThrow(/\[0, 1\]/);
    expect(() =>
      validateAntiSignalAttenuation({ coordinatedBurstMax: 0.5, harassmentCascade: -0.1 }),
    ).toThrow(/\[0, 1\]/);
  });
});

describe('anti-signal attenuation of the served components (WS-E.2.2 → WS-I)', () => {
  const active = (overrides: Partial<ActorItemSummary> = {}) =>
    actor({
      dwellBucket: 'extended',
      sourceOpened: true,
      contextOpened: true,
      contributions: { correction: 2 },
      ...overrides,
    });

  it('no anti-signal ⇒ factor 1 and served == raw', () => {
    const result = computePwattV1Components(
      [active({ actor: 'a' }), active({ actor: 'b' })],
      DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
      {},
    );
    expect(result.antiSignalFactor).toBe(1);
    expect(result.activeAttention).toBe(result.rawActiveAttention);
    expect(result.participation).toBe(result.rawParticipation);
    expect(result.antiSignalAnnotations).toEqual([]);
  });

  it('a full-confidence coordinated burst attenuates the served components', () => {
    const actors = [active({ actor: 'a' }), active({ actor: 'b' }), active({ actor: 'c' })];
    const clean = computePwattV1Components(actors, DEFAULT_PWATT_V1_COMPONENTS_CONFIG, {});
    const burst = computePwattV1Components(actors, DEFAULT_PWATT_V1_COMPONENTS_CONFIG, {
      coordinatedBurst: { confidence: 1 },
    });
    // Raw is unchanged; served is scaled by (1 - coordinatedBurstMax).
    expect(burst.rawActiveAttention).toBeCloseTo(clean.rawActiveAttention, 12);
    expect(burst.antiSignalFactor).toBeCloseTo(
      1 - DEFAULT_ANTI_SIGNAL_ATTENUATION.coordinatedBurstMax,
      12,
    );
    expect(burst.activeAttention).toBeLessThan(clean.activeAttention);
    expect(burst.participation).toBeLessThan(clean.participation);
    expect(burst.antiSignalAnnotations).toContain('coordinated_burst_attenuated');
  });

  it('attenuation is monotone in burst confidence and composes with a cascade', () => {
    const actors = [active({ actor: 'a' }), active({ actor: 'b' })];
    const f = (signals: ItemAntiSignals) =>
      computePwattV1Components(actors, DEFAULT_PWATT_V1_COMPONENTS_CONFIG, signals)
        .antiSignalFactor;
    expect(f({ coordinatedBurst: { confidence: 0.2 } })).toBeGreaterThan(
      f({ coordinatedBurst: { confidence: 0.8 } }),
    );
    // Both signals compose multiplicatively ⇒ strictly smaller than either alone.
    const both = f({ coordinatedBurst: { confidence: 1 }, harassmentCascade: true });
    expect(both).toBeLessThan(f({ coordinatedBurst: { confidence: 1 } }));
    expect(both).toBeLessThan(f({ harassmentCascade: true }));
  });

  it('the pure attenuation helper is total and identity-on-empty', () => {
    expect(antiSignalAttenuation(undefined).factor).toBe(1);
    expect(antiSignalAttenuation({}).factor).toBe(1);
    expect(antiSignalAttenuation({ harassmentCascade: false }).factor).toBe(1);
    // A NaN confidence clamps to 0 ⇒ no attenuation (totality).
    expect(antiSignalAttenuation({ coordinatedBurst: { confidence: Number.NaN } }).factor).toBe(1);
  });
});
