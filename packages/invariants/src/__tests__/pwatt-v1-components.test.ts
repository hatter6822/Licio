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
  computePwattV1Components,
  DEFAULT_ANTI_SIGNAL_ATTENUATION,
  DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
  type ItemAntiSignals,
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
  it('the hierarchy affects output: correction > … > explanation', () => {
    const order = ['correction', 'synthesis', 'question', 'counterexample', 'explanation'] as const;
    const values = order.map(
      (type) => actorV1Contribution(actor({ contributions: { [type]: 1 } })).value,
    );
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i - 1]).toBeGreaterThan(values[i] ?? Number.POSITIVE_INFINITY);
    }
    expect(actorV1Contribution(actor({ contributions: { low_info_reply: 5 } })).value).toBe(0);
    expect(actorV1Contribution(actor({ contributions: { flag: 5 } })).value).toBe(0);
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
    const calm = actorV1Contribution(actor({ contributions: { question: 3 } }));
    const rapid = actorV1Contribution(actor({ contributions: { question: 9 } }));
    expect(rapid.value).toBeLessThan(calm.value);
    expect(rapid.annotations).toContain('rapid_repetition_dampened');
  });

  it('property: adding any contribution never lowers the pre-dampening score', () => {
    const types = ['correction', 'synthesis', 'question'] as const;
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
        contributionWeights: { ...V1_CONTRIBUTION_WEIGHTS, flag: 0.2 },
      }),
    ).toThrow(/flag must carry zero/);
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
