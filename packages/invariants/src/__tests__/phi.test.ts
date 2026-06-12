// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI tests (WS-H.6): frame orthonormalization, transport orthogonality,
// holonomy composition, the score at analytic anchors (identity, known
// rotations, near-π fallback), score ordering, gauge invariance (including
// the deliberately-frame-dependent failure case and the boundary scan),
// v0 narrow-loop/compulsive detection, and threshold strictness.
import { describe, expect, it } from 'vitest';
import {
  identity,
  isOrthogonal,
  type Matrix,
  matMul,
  randomOrthogonal,
  transpose,
} from '../math/linalg.js';
import { mulberry32 } from '../math/rng.js';
import {
  appendTransition,
  assertGaugeInvariantBoundary,
  DEFAULT_PHI_THRESHOLD_CONFIG,
  detectCompulsiveSession,
  detectNarrowLoop,
  effectivePhiThreshold,
  effectiveRepeatThreshold,
  holonomy,
  orthonormalFrame,
  phiScore,
  type TopicTransition,
  transportBetween,
  validatePhiThresholdConfig,
  verifyGaugeInvariance,
} from '../phi/index.js';

function rotation2(theta: number): Matrix {
  return [
    [Math.cos(theta), -Math.sin(theta)],
    [Math.sin(theta), Math.cos(theta)],
  ];
}

describe('PHI frames and transports (WS-H.6.2a/b)', () => {
  it('orthonormalizes raw frames and rejects rank deficiency', () => {
    const frame = orthonormalFrame([
      [2, 0],
      [1, 1],
    ]);
    expect(frame).not.toBeNull();
    if (frame) expect(isOrthogonal(frame)).toBe(true);
    expect(
      orthonormalFrame([
        [1, 1],
        [2, 2],
      ]),
    ).toBeNull();
  });

  it('transports between orthonormal frames are orthogonal and exact', () => {
    const fx = rotation2(0.3);
    const fy = rotation2(1.1);
    const a = transportBetween(fx, fy);
    expect(isOrthogonal(a)).toBe(true);
    // A F_x = F_y exactly for full frames.
    const diff = matMul(a, fx).map((row, i) => row.map((v, j) => v - (fy[i]?.[j] ?? 0)));
    expect(Math.max(...diff.flat().map(Math.abs))).toBeLessThan(1e-10);
    expect(() =>
      transportBetween(
        [
          [1, 1],
          [0, 1],
        ],
        fy,
      ),
    ).toThrow(/orthonormal/);
  });

  it('holonomy of identity transports is I; transports validated', () => {
    const h = holonomy([identity(3), identity(3)]);
    expect(h).toEqual(identity(3));
    expect(() =>
      holonomy([
        [
          [1, 2],
          [0, 1],
        ],
      ]),
    ).toThrow(/orthogonal/);
    expect(() => holonomy([])).toThrow(/at least one/);
  });
});

describe('PHI score (WS-H.6.2c)', () => {
  it('identity holonomy produces PHI = 0', () => {
    const result = phiScore(identity(4));
    expect(result.phi).toBe(0);
    expect(result.rotationAngles).toEqual([]);
    expect(result.fallback).toBe(false);
  });

  it('a known rotation produces the analytic value √2·θ', () => {
    for (const theta of [0.2, 0.7, Math.PI / 2, 2.5]) {
      const result = phiScore(rotation2(theta));
      expect(result.fallback).toBe(false);
      expect(result.phi).toBeCloseTo(Math.SQRT2 * theta, 8);
      expect(result.rotationAngles[0]).toBeCloseTo(theta, 8);
    }
  });

  it('a 4D two-block rotation sums angles in quadrature', () => {
    const theta1 = 0.5;
    const theta2 = 1.2;
    const h: Matrix = [
      [Math.cos(theta1), -Math.sin(theta1), 0, 0],
      [Math.sin(theta1), Math.cos(theta1), 0, 0],
      [0, 0, Math.cos(theta2), -Math.sin(theta2)],
      [0, 0, Math.sin(theta2), Math.cos(theta2)],
    ];
    const result = phiScore(h);
    expect(result.phi).toBeCloseTo(Math.sqrt(2 * (theta1 ** 2 + theta2 ** 2)), 8);
    expect(result.rotationAngles.length).toBe(2);
  });

  it('near-π rotations trigger the robust fallback with MATRIX_LOG_FALLBACK', () => {
    const result = phiScore(rotation2(Math.PI));
    expect(result.fallback).toBe(true);
    expect(result.reasonCodes).toContain('MATRIX_LOG_FALLBACK');
    // ‖R(π) − I‖_F = ‖diag(−2, −2)‖_F = 2√2 — finite.
    expect(result.phi).toBeCloseTo(2 * Math.SQRT2, 8);
  });

  it('orientation-reversing holonomy (det = −1) falls back too', () => {
    const reflection: Matrix = [
      [1, 0],
      [0, -1],
    ];
    const result = phiScore(reflection);
    expect(result.fallback).toBe(true);
    expect(result.reasonCodes).toContain('MATRIX_LOG_FALLBACK');
    expect(Number.isFinite(result.phi)).toBe(true);
  });

  it('PHI ordering: larger rotations produce larger PHI', () => {
    const small = phiScore(rotation2(0.2)).phi;
    const medium = phiScore(rotation2(1.0)).phi;
    const large = phiScore(rotation2(2.8)).phi;
    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
  });

  it('rejects non-orthogonal input', () => {
    expect(() =>
      phiScore([
        [2, 0],
        [0, 0.5],
      ]),
    ).toThrow(/orthogonal/);
  });
});

describe('PHI gauge invariance (WS-H.6.2c-2)', () => {
  it('conjugation by random orthogonal Q leaves the summary invariant', () => {
    const h = rotation2(1.3);
    const verification = verifyGaugeInvariance(h, { seed: 7, trials: 12, tolerance: 1e-7 });
    expect(verification.invariant).toBe(true);
    expect(verification.maxDeviation).toBeLessThan(1e-7);
  });

  it('gauge invariance holds in higher dimensions', () => {
    const h: Matrix = [
      [Math.cos(0.9), -Math.sin(0.9), 0],
      [Math.sin(0.9), Math.cos(0.9), 0],
      [0, 0, 1],
    ];
    const verification = verifyGaugeInvariance(h, { seed: 3, trials: 8, tolerance: 1e-6 });
    expect(verification.invariant).toBe(true);
  });

  it('a deliberately frame-dependent summary fails the gauge check', () => {
    // The (0,0) raw entry is NOT conjugation-invariant in n ≥ 3 (in 2D every
    // conjugation fixes cos θ, so the check must run in higher dimension —
    // conjugating a 3D rotation moves its axis).
    const h: Matrix = [
      [Math.cos(1.0), -Math.sin(1.0), 0],
      [Math.sin(1.0), Math.cos(1.0), 0],
      [0, 0, 1],
    ];
    const q = randomOrthogonal(3, mulberry32(11));
    const conjugated = matMul(matMul(q, h), transpose(q));
    const frameDependent = (m: Matrix): number => m[0]?.[0] ?? 0;
    expect(Math.abs(frameDependent(h) - frameDependent(conjugated))).toBeGreaterThan(1e-6);
    // While the gauge-invariant summary agrees on both.
    expect(phiScore(conjugated).phi).toBeCloseTo(phiScore(h).phi, 8);
  });

  it('the boundary scan rejects frame-dependent fields and unknown keys', () => {
    expect(() =>
      assertGaugeInvariantBoundary({
        phi: 1,
        rotation_angles: [1],
        loop_path: [],
        fallback_log: false,
        sensitive: false,
      }),
    ).not.toThrow();
    expect(() => assertGaugeInvariantBoundary({ phi: 1, matrix_entry_00: 0.4 })).toThrow(
      /boundary violation/,
    );
    expect(() => assertGaugeInvariantBoundary({ phi: 1, embedding_x: 0.4 })).toThrow(
      /boundary violation/,
    );
  });
});

describe('PHI v0 loop detection (WS-H.6.1a/b)', () => {
  const t = (cluster: string, atMs: number): TopicTransition => ({
    topicClusterId: cluster,
    atMs,
  });

  it('enforces the bounded sequence cap (oldest dropped)', () => {
    let sequence: TopicTransition[] = [];
    for (let i = 0; i < 250; i += 1) sequence = appendTransition(sequence, t(`c${i}`, i), 200);
    expect(sequence.length).toBe(200);
    expect(sequence[0]?.topicClusterId).toBe('c50');
  });

  it('detects a narrow loop and extracts the closed loop path', () => {
    const sequence = [t('a', 0), t('b', 60_000), t('a', 120_000), t('c', 180_000), t('a', 240_000)];
    const detection = detectNarrowLoop(sequence, 250_000);
    expect(detection.detected).toBe(true);
    expect(detection.topicClusterId).toBe('a');
    expect(detection.occurrences).toBe(3);
    expect(detection.loopPath).toEqual(['a', 'b', 'a', 'c', 'a']);
  });

  it('continuous reading of one topic is NOT a loop (re-entry is the signal)', () => {
    const sequence = [t('a', 0), t('a', 30_000), t('a', 60_000), t('a', 90_000)];
    expect(detectNarrowLoop(sequence, 100_000).detected).toBe(false);
  });

  it('a diverse session does not trigger detection', () => {
    const sequence = [t('a', 0), t('b', 60_000), t('c', 120_000), t('d', 180_000)];
    expect(detectNarrowLoop(sequence, 200_000).detected).toBe(false);
  });

  it('detects compulsive rapid exit-and-return patterns', () => {
    const sequence = [
      t('a', 0),
      t('b', 10_000),
      t('a', 20_000),
      t('b', 30_000),
      t('a', 40_000),
      t('b', 50_000),
      t('a', 60_000),
    ];
    const detection = detectCompulsiveSession(sequence);
    expect(detection.detected).toBe(true);
    expect(detection.topicClusterId).toBe('a');
    expect(detection.rapidReturns).toBeGreaterThanOrEqual(3);
  });

  it('slow revisits are not compulsive', () => {
    const sequence = [
      t('a', 0),
      t('b', 3_600_000),
      t('a', 7_200_000),
      t('b', 10_800_000),
      t('a', 14_400_000),
    ];
    expect(detectCompulsiveSession(sequence).detected).toBe(false);
  });
});

describe('PHI thresholds (WS-H.6.2d)', () => {
  it('sensitive topics and minors get strictly lower thresholds', () => {
    const base = effectivePhiThreshold({ sensitiveTopic: false, isMinor: false });
    const sensitive = effectivePhiThreshold({ sensitiveTopic: true, isMinor: false });
    const minor = effectivePhiThreshold({ sensitiveTopic: false, isMinor: true });
    const both = effectivePhiThreshold({ sensitiveTopic: true, isMinor: true });
    expect(sensitive).toBeLessThan(base);
    expect(minor).toBeLessThan(base);
    expect(both).toBeLessThan(sensitive);
    expect(both).toBeLessThan(minor);
  });

  it('repeat thresholds tighten but never drop below 2', () => {
    expect(effectiveRepeatThreshold({ sensitiveTopic: false, isMinor: false })).toBe(3);
    expect(effectiveRepeatThreshold({ sensitiveTopic: true, isMinor: true })).toBe(2);
  });

  it('rejects configs that would weaken protection (factor > 1)', () => {
    expect(validatePhiThresholdConfig(DEFAULT_PHI_THRESHOLD_CONFIG)).toBeNull();
    expect(
      validatePhiThresholdConfig({ ...DEFAULT_PHI_THRESHOLD_CONFIG, sensitiveTopicFactor: 1.5 }),
    ).toMatch(/weaken/);
    expect(
      validatePhiThresholdConfig({ ...DEFAULT_PHI_THRESHOLD_CONFIG, baseRepeatThreshold: 1 }),
    ).toMatch(/>= 2/);
  });
});
