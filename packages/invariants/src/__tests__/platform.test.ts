// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Platform tests (WS-H.1): reason-code registry, envelope builders,
// score-vector schemas (accept/reject + discriminated routing + snapshot),
// the invariant-card schema, the promotion gate (no advance without a
// valid record; demotion always available), synthetic-dataset determinism,
// and the regression harness (passes on baselines; flags intentional drift).
import { describe, expect, it } from 'vitest';
import {
  buildEnvelope,
  DEFAULT_PROMOTION_POLICY,
  degradedEnvelope,
  emptyHealthMetrics,
  enforcementAllowed,
  fallbackUsedFrom,
  generateGweiDataset,
  generateMeriDataset,
  generateMfciDataset,
  type InvariantCard,
  InvariantType,
  invariantCardSchema,
  isReasonCode,
  type PromotionRecord,
  REASON_CODES,
  REGRESSION_BASELINES,
  REGRESSION_SEED,
  resolveShadowStatus,
  runRegressionSuite,
  SCORE_VECTOR_SCHEMAS,
  typedScoreVectorSchema,
  validatePromotion,
  validateReasonCodes,
  validateScoreVector,
} from '../index.js';

describe('reason codes (WS-H.1.1c)', () => {
  it('the registry is closed and validation rejects unknown codes', () => {
    expect(isReasonCode('INSUFFICIENT_COVERAGE')).toBe(true);
    expect(isReasonCode('MADE_UP_CODE')).toBe(false);
    expect(validateReasonCodes(['TIMEOUT', 'COMPUTE_ERROR'])).toBeNull();
    expect(validateReasonCodes(['TIMEOUT', 'NOPE'])).toBe('NOPE');
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });

  it('fallback_used derives from the fallback codes', () => {
    expect(fallbackUsedFrom(['MATRIX_LOG_FALLBACK'])).toBe(true);
    expect(fallbackUsedFrom(['INSUFFICIENT_COVERAGE'])).toBe(false);
    expect(fallbackUsedFrom([])).toBe(false);
  });

  it('envelopes validate codes and clamp ranges; degraded carries no score', () => {
    const envelope = buildEnvelope({
      scoreVector: { meri: 0.5 },
      confidence: 1.4,
      coverage: -0.1,
      reasonCodes: ['APPROXIMATION_FALLBACK'],
      version: '1.0.0',
    });
    expect(envelope.confidence).toBe(1);
    expect(envelope.coverage).toBe(0);
    expect(envelope.fallback_used).toBe(true);
    expect(() =>
      buildEnvelope({
        scoreVector: {},
        confidence: 1,
        coverage: 1,
        reasonCodes: ['X'],
        version: '1.0.0',
      }),
    ).toThrow(/unknown reason code/);

    const degraded = degradedEnvelope('1.0.0', ['TIMEOUT']);
    expect(degraded.confidence).toBe(0);
    expect(degraded.score_vector).toEqual({});
    expect(degraded.fallback_used).toBe(true);
  });
});

describe('score-vector schemas (WS-H.1.1d)', () => {
  it('accepts a valid vector and rejects malformed ones for each type', () => {
    const valid: Record<string, Record<string, unknown>> = {
      [InvariantType.MERI]: {
        meri: 0.8,
        marginal_gains: { a: 1 },
        approximation: false,
        per_class_bounds: { 'near_duplicate:x': 1 },
        group_ids: ['near_duplicate:x'],
      },
      [InvariantType.MFCI]: {
        mfci: 5.2,
        p_hat: 0.005,
        statistic: 'synchrony',
        sample_count: 10_000,
        fixed_margins_ref: 'margins:abc',
        risk_state: 'high',
      },
      [InvariantType.GWEI]: {
        gw2: 0.4,
        ci_low: 0.35,
        ci_high: 0.5,
        seed_count: 3,
        regularization: 0.05,
        cohort_a: 'lang:en',
        cohort_b: 'lang:es',
        metric_breakdown: { sourceDiversity: 3.1 },
      },
      [InvariantType.SCOI]: {
        scoi: 0.6,
        normalizer: 8,
        overlap_count: 2,
        lens_count: 3,
        context_state: 'split',
        per_overlap_energy: { 'l1~l2': 2.4 },
      },
      [InvariantType.PHI]: {
        phi: 1.2,
        rotation_angles: [0.85],
        loop_path: ['c1', 'c2', 'c1'],
        fallback_log: false,
        sensitive: false,
      },
      [InvariantType.HodgeTension]: {
        gradient_magnitude: 1,
        curl_magnitude: 0.5,
        harmonic_magnitude: 0.3,
        harmonic_fraction: 0.09,
        harmful_tension_risk: 0,
        label: 'high_disagreement_low_hostility',
      },
      [InvariantType.TropicalCascade]: {
        synchronized_fraction: 0.8,
        arrival_profile_rank: 1,
        seed_count: 4,
        coordinated_drop_count: 6,
        detected: true,
      },
      [InvariantType.BraidDynamics]: {
        crossing_number: 12,
        entropy: 0.96,
        crossing_rate: 3,
        strands: 5,
        manufactured_churn: false,
        threshold_gaming_count: 0,
      },
      [InvariantType.ReebLandscape]: {
        peak_count: 2,
        merge_count: 1,
        split_count: 1,
        fragile_saddle_count: 1,
        final_basin_count: 1,
      },
      [InvariantType.CounterfactualDefect]: {
        cid: 0.01,
        element_count: 4,
        threshold: 0.1,
        blocked: false,
      },
      [InvariantType.PathSignatureWellbeing]: {
        classification: 'constructive',
        event_count: 40,
        distinct_topics: 6,
        deep_action_share: 0.4,
        rapid_return_count: 0,
        action_time_area: 0.2,
      },
    };
    for (const [type, vector] of Object.entries(valid)) {
      expect(validateScoreVector(type, vector)).toEqual({ ok: true });
      // Unreviewed extra fields are rejected (strict schemas).
      const widened = validateScoreVector(type, { ...vector, smuggled: 1 });
      expect(widened.ok).toBe(false);
    }
    // Malformed: out-of-range and wrong-type fields.
    expect(validateScoreVector(InvariantType.MERI, { meri: 2 }).ok).toBe(false);
    expect(
      validateScoreVector(InvariantType.MFCI, {
        mfci: 1,
        p_hat: 0, // must be > 0 (add-one estimator guarantees it)
        statistic: 'synchrony',
        sample_count: 10,
        fixed_margins_ref: 'x',
        risk_state: 'high',
      }).ok,
    ).toBe(false);
    expect(validateScoreVector('PWAtt_v0', { score: 0.5 })).toEqual({ ok: true });
    expect(validateScoreVector('PWAtt_v0', { score: 'high' }).ok).toBe(false);
    expect(validateScoreVector('unknown_type', {}).ok).toBe(false);
  });

  it('the discriminated union routes by invariant_type', () => {
    const parsed = typedScoreVectorSchema.parse({
      invariant_type: InvariantType.SCOI,
      score_vector: {
        scoi: 0.2,
        normalizer: 4,
        overlap_count: 1,
        lens_count: 2,
        context_state: 'ambiguous',
        per_overlap_energy: {},
      },
    });
    expect(parsed.invariant_type).toBe(InvariantType.SCOI);
    expect(() =>
      typedScoreVectorSchema.parse({
        invariant_type: InvariantType.SCOI,
        score_vector: { phi: 1 },
      }),
    ).toThrow();
  });

  it('score-vector shapes are pinned by snapshot (unreviewed change fails)', () => {
    const shapes = Object.fromEntries(
      Object.entries(SCORE_VECTOR_SCHEMAS).map(([type, schema]) => {
        const def = schema as unknown as { def?: { shape?: Record<string, unknown> } };
        const inner =
          def.def && 'shape' in def.def && def.def.shape
            ? Object.keys(def.def.shape).sort()
            : 'non-object';
        return [type, inner];
      }),
    );
    expect(shapes).toMatchSnapshot();
  });
});

const validCard: InvariantCard = {
  invariant_type: InvariantType.MERI,
  owner: 'ranking-invariants',
  version: '1.0.0',
  input_schema: 'docs/invariants/README.md#meri-inputs',
  output_schema: 'meriScoreVectorSchema',
  confidence_bounds: { min: 0.2, typical: 0.8, max: 1 },
  coverage_bounds: { min_acceptable: 0.5, typical: 0.9 },
  coverage_definition: 'Fraction of candidates with all independence inputs available and fresh.',
  known_failure_modes: [
    {
      mode: 'contradictory grouping inputs',
      impact: 'partition matroid invalid; rank would be wrong',
      mitigation: 'similarity-graph fallback with MATROID_FALLBACK',
    },
  ],
  fallback_behavior: 'Greedy similarity approximation, flagged, confidence halved.',
  approximation_notes: 'Fallback greedy carries the 1−1/e / 1/2 guarantees.',
  shadow_status: 'shadow',
  dependencies: ['WS-F dedup groups', 'WS-F source lineage'],
};

describe('invariant card schema (WS-H.1.2b)', () => {
  it('parses a complete card and rejects missing fields', () => {
    expect(invariantCardSchema.parse(validCard)).toBeTruthy();
    const { owner: _owner, ...missingOwner } = validCard;
    expect(invariantCardSchema.safeParse(missingOwner).success).toBe(false);
    expect(invariantCardSchema.safeParse({ ...validCard, known_failure_modes: [] }).success).toBe(
      false,
    );
    expect(invariantCardSchema.safeParse({ ...validCard, version: 'v1' }).success).toBe(false);
    expect(
      invariantCardSchema.safeParse({
        ...validCard,
        confidence_bounds: { min: 0.9, typical: 0.5, max: 1 },
      }).success,
    ).toBe(false);
  });

  it('shadow_status defaults to shadow', () => {
    const { shadow_status: _status, ...withoutStatus } = validCard;
    expect(invariantCardSchema.parse(withoutStatus).shadow_status).toBe('shadow');
  });
});

describe('promotion gate (WS-H.1.2e)', () => {
  const promotion = (overrides: Partial<PromotionRecord> = {}): PromotionRecord => ({
    invariantType: InvariantType.MERI,
    fromStatus: 'shadow',
    toStatus: 'soft_constraint',
    evidence: {
      shadowDurationDays: 30,
      driftReportRef: 'regression-run-2026-06-01',
      observedCoverage: 0.9,
      observedConfidence: 0.8,
    },
    owner: 'ranking-lead',
    createdAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  });

  it('status cannot advance without a valid promotion record', () => {
    expect(resolveShadowStatus([])).toBe('shadow');
    expect(validatePromotion(promotion(), validCard, [])).toBeNull();
    expect(
      validatePromotion(
        promotion({ evidence: { ...promotion().evidence, shadowDurationDays: 3 } }),
        validCard,
        [],
      ),
    ).toMatch(/shadow days/);
    expect(
      validatePromotion(
        promotion({ evidence: { ...promotion().evidence, observedCoverage: 0.3 } }),
        validCard,
        [],
      ),
    ).toMatch(/coverage/);
    expect(
      validatePromotion(
        promotion({ evidence: { ...promotion().evidence, observedConfidence: 0.05 } }),
        validCard,
        [],
      ),
    ).toMatch(/confidence/);
    expect(validatePromotion(promotion({ owner: ' ' }), validCard, [])).toMatch(/owner/);
    expect(
      validatePromotion(
        promotion({ evidence: { ...promotion().evidence, driftReportRef: '' } }),
        validCard,
        [],
      ),
    ).toMatch(/drift/);
  });

  it('promotions advance one step; no jumping shadow → hard_constraint', () => {
    expect(validatePromotion(promotion({ toStatus: 'hard_constraint' }), validCard, [])).toMatch(
      /one status step/,
    );
    expect(validatePromotion(promotion({ fromStatus: 'soft_constraint' }), validCard, [])).toMatch(
      /does not match current/,
    );
  });

  it('demotion (the kill switch) is always available and changes resolution', () => {
    const promoted = promotion();
    const history: PromotionRecord[] = [promoted];
    expect(resolveShadowStatus(history)).toBe('soft_constraint');
    const demotion = promotion({
      fromStatus: 'soft_constraint',
      toStatus: 'shadow',
      evidence: {
        shadowDurationDays: 0,
        driftReportRef: 'incident-123',
        observedCoverage: 0,
        observedConfidence: 0,
      },
    });
    expect(validatePromotion(demotion, validCard, history)).toBeNull();
    expect(resolveShadowStatus([...history, demotion])).toBe('shadow');
  });

  it('enforcementAllowed is the single shadow gate', () => {
    expect(enforcementAllowed('shadow')).toBe(false);
    expect(enforcementAllowed('soft_constraint')).toBe(true);
    expect(enforcementAllowed('hard_constraint')).toBe(true);
  });

  it('policy default requires two weeks of shadow', () => {
    expect(DEFAULT_PROMOTION_POLICY.minShadowDays).toBe(14);
  });
});

describe('synthetic datasets (WS-H.1.2d)', () => {
  it('the same seed reproduces identical data; different seeds differ', () => {
    expect(generateMeriDataset(REGRESSION_SEED)).toEqual(generateMeriDataset(REGRESSION_SEED));
    expect(generateMfciDataset(5, true).table.cells).toEqual(
      generateMfciDataset(5, true).table.cells,
    );
    const a = generateGweiDataset(1, false);
    const b = generateGweiDataset(1, false);
    expect(a).toEqual(b);
    expect(generateGweiDataset(1, false)).not.toEqual(generateGweiDataset(2, false));
  });

  it('health metrics start empty', () => {
    expect(emptyHealthMetrics().outputCount).toBe(0);
  });
});

describe('regression harness (WS-H.1.2d-2)', () => {
  it('the full suite passes against the pinned baselines', () => {
    const report = runRegressionSuite();
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
    // Every invariant is represented.
    const invariants = new Set(report.checks.map((c) => c.invariant));
    expect(invariants.size).toBe(11);
  });

  it('intentional drift is flagged with its deviation magnitude', () => {
    const report = runRegressionSuite({
      ...REGRESSION_BASELINES,
      meriStandard: REGRESSION_BASELINES.meriStandard + 0.2,
    });
    expect(report.pass).toBe(false);
    const failure = report.failures.find((f) => f.invariant === 'MERI');
    expect(failure).toBeTruthy();
    expect(failure?.deviation).toBeCloseTo(0.2, 9);
  });
});
