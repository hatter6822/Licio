// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { InvariantOutput, InvariantVersion } from '../types.js';
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
  it('accepts a well-formed output', () => {
    const version: InvariantVersion = { major: 1, minor: 0, patch: 0 };
    const output: InvariantOutput = {
      type: InvariantType.MERI,
      version,
      confidence: 0.95,
      coverage: 0.88,
      reasonCodes: ['MATROID_FALLBACK'],
      fallbackBehavior: 'degrade-gracefully',
      timestamp: new Date().toISOString(),
    };
    expect(output.type).toBe(InvariantType.MERI);
    expect(output.confidence).toBeGreaterThan(0);
    expect(output.coverage).toBeGreaterThan(0);
    expect(output.reasonCodes).toHaveLength(1);
  });
});
