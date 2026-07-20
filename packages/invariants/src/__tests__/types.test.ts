// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { InvariantOutput } from '../types.js';
import { INVARIANT_TARGET_TYPES, INVARIANT_TYPE_NAMES, InvariantType } from '../types.js';

describe('InvariantType', () => {
  it('has the five core invariant types', () => {
    expect(InvariantType.MERI).toBe('MERI');
    expect(InvariantType.MFCI).toBe('MFCI');
    expect(InvariantType.GWEI).toBe('GWEI');
    expect(InvariantType.SCOI).toBe('SCOI');
    expect(InvariantType.PHI).toBe('PHI');
  });

  it('has the six supporting invariant types (WS-H.1.1a)', () => {
    expect(InvariantType.HodgeTension).toBe('hodge_tension');
    expect(InvariantType.TropicalCascade).toBe('tropical_cascade');
    expect(InvariantType.BraidDynamics).toBe('braid_dynamics');
    expect(InvariantType.ReebLandscape).toBe('reeb_landscape');
    expect(InvariantType.CounterfactualDefect).toBe('counterfactual_defect');
    expect(InvariantType.PathSignatureWellbeing).toBe('path_signature_wellbeing');
  });

  it('has exactly 11 values, mirrored by INVARIANT_TYPE_NAMES', () => {
    const values = Object.values(InvariantType);
    expect(values).toHaveLength(11);
    expect([...INVARIANT_TYPE_NAMES]).toEqual(values);
  });

  it('exposes the six §22.1 target types', () => {
    expect([...INVARIANT_TARGET_TYPES]).toEqual([
      'story',
      'thread',
      'feed',
      'room',
      'cohort',
      'session',
    ]);
  });
});

describe('InvariantOutput', () => {
  it('accepts a well-formed output aligned with the §22.1 SSOT', () => {
    const output: InvariantOutput = {
      type: InvariantType.MERI,
      target: { targetType: 'story', targetId: 'story-1' },
      window: { start: '2026-07-19T00:00:00.000Z', end: '2026-07-19T01:00:00.000Z' },
      version: '1.0.0',
      score_vector: { meri: 0.72 },
      confidence: 0.95,
      coverage: 0.88,
      reason_codes: ['MATROID_FALLBACK'],
      fallback_used: true,
      timestamp: new Date().toISOString(),
    };
    expect(output.type).toBe(InvariantType.MERI);
    expect(output.version).toBe('1.0.0');
    expect(output.confidence).toBeGreaterThan(0);
    expect(output.coverage).toBeGreaterThan(0);
    expect(output.reason_codes).toHaveLength(1);
    expect(output.fallback_used).toBe(true);
    expect(output.target.targetType).toBe('story');
    expect(output.score_vector).toMatchObject({ meri: 0.72 });
  });
});
