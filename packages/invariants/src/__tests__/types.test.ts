// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { InvariantType } from '../types.js';
import type { InvariantOutput, InvariantVersion } from '../types.js';

describe('InvariantType', () => {
  it('should have all five core invariant types', () => {
    expect(InvariantType.MERI).toBe('MERI');
    expect(InvariantType.MFCI).toBe('MFCI');
    expect(InvariantType.GWEI).toBe('GWEI');
    expect(InvariantType.SCOI).toBe('SCOI');
    expect(InvariantType.PHI).toBe('PHI');
  });

  it('should have exactly 5 values', () => {
    const values = Object.values(InvariantType);
    expect(values).toHaveLength(5);
  });
});

describe('InvariantOutput', () => {
  it('should accept a well-formed output', () => {
    const version: InvariantVersion = { major: 1, minor: 0, patch: 0 };
    const output: InvariantOutput = {
      type: InvariantType.MERI,
      version,
      confidence: 0.95,
      coverage: 0.88,
      reasonCodes: ['MERI-001'],
      fallbackBehavior: 'degrade-gracefully',
      timestamp: new Date().toISOString(),
    };
    expect(output.type).toBe(InvariantType.MERI);
    expect(output.confidence).toBeGreaterThan(0);
    expect(output.coverage).toBeGreaterThan(0);
    expect(output.reasonCodes).toHaveLength(1);
  });
});
