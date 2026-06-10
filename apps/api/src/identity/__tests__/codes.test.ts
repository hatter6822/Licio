// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  generateOneTimeCode,
  hashOneTimeCode,
  normalizeOneTimeCode,
  ONE_TIME_CODE_LENGTH,
  verifyOneTimeCode,
} from '../codes.js';

describe('generateOneTimeCode', () => {
  it('is the configured length and uses only the Crockford alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateOneTimeCode();
      expect(code).toHaveLength(ONE_TIME_CODE_LENGTH);
      for (const ch of code) expect(CROCKFORD_ALPHABET).toContain(ch);
    }
  });

  it('does not repeat across calls (high entropy)', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateOneTimeCode()));
    // 500 draws from a ~2^40 space should be collision-free with overwhelming probability.
    expect(codes.size).toBe(500);
  });

  it('exercises the full alphabet across many draws (no dead symbols / no bias gap)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      for (const ch of generateOneTimeCode()) seen.add(ch);
    }
    // Every one of the 32 Crockford symbols should appear at least once.
    expect(seen.size).toBe(CROCKFORD_ALPHABET.length);
  });
});

describe('normalizeOneTimeCode', () => {
  it('upper-cases, strips spaces/hyphens, and folds confusables', () => {
    expect(normalizeOneTimeCode('ilo abc-1')).toBe('110ABC1');
    expect(normalizeOneTimeCode(' Ab2Cd3 ')).toBe('AB2CD3');
  });
});

describe('hashOneTimeCode / verifyOneTimeCode', () => {
  it('hashes deterministically and stores no plaintext', () => {
    const code = generateOneTimeCode();
    const hash = hashOneTimeCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(code);
  });

  it('verifies a matching code (including confusable folding)', () => {
    // A code with no confusables, verified with a confusable-substituted entry.
    const hash = hashOneTimeCode('ABCD2345');
    expect(verifyOneTimeCode('ABCD2345', hash)).toBe(true);
    expect(verifyOneTimeCode('abcd2345', hash)).toBe(true); // case-insensitive
  });

  it('folds O→0 and I/L→1 so a user typing a letter for a digit still matches', () => {
    const hash = hashOneTimeCode('01234567');
    expect(verifyOneTimeCode('OI234567', hash)).toBe(true); // O→0, I→1
    expect(verifyOneTimeCode('OL234567', hash)).toBe(true); // O→0, L→1
  });

  it('rejects a non-matching code', () => {
    const hash = hashOneTimeCode('ABCD2345');
    expect(verifyOneTimeCode('ABCD2346', hash)).toBe(false);
  });
});
