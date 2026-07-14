// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared asset registry + exact human-amount parser (WS-M): string math
// only, excess precision rejects (never rounds), zero and malformed reject,
// and the round-trip with formatMinorUnits is exact.
import { describe, expect, it } from 'vitest';
import {
  formatMinorUnits,
  KNOMOSIS_ASSET_DECIMALS,
  parseHumanAmountToMinorUnits,
} from '../knomosis/index.js';

describe('parseHumanAmountToMinorUnits (WS-M exact decimal math)', () => {
  it('converts human decimals to exact minor units', () => {
    expect(parseHumanAmountToMinorUnits('1.5', 6)).toBe('1500000');
    expect(parseHumanAmountToMinorUnits('0.000001', 6)).toBe('1');
    expect(parseHumanAmountToMinorUnits('2', 6)).toBe('2000000');
    expect(parseHumanAmountToMinorUnits('10', 0)).toBe('10');
    expect(parseHumanAmountToMinorUnits(' 3.25 ', 2)).toBe('325');
  });

  it('rejects excess precision instead of rounding', () => {
    expect(parseHumanAmountToMinorUnits('1.1234567', 6)).toBeNull();
    expect(parseHumanAmountToMinorUnits('0.001', 2)).toBeNull();
  });

  it('rejects zero, negatives, and malformed input', () => {
    expect(parseHumanAmountToMinorUnits('0', 6)).toBeNull();
    expect(parseHumanAmountToMinorUnits('0.000000', 6)).toBeNull();
    expect(parseHumanAmountToMinorUnits('-1', 6)).toBeNull();
    expect(parseHumanAmountToMinorUnits('1,5', 6)).toBeNull();
    expect(parseHumanAmountToMinorUnits('1e6', 6)).toBeNull();
    expect(parseHumanAmountToMinorUnits('', 6)).toBeNull();
    expect(parseHumanAmountToMinorUnits('.5', 6)).toBeNull();
    expect(parseHumanAmountToMinorUnits('1.', 6)).toBeNull();
  });

  it('rejects out-of-range decimals', () => {
    expect(parseHumanAmountToMinorUnits('1', -1)).toBeNull();
    expect(parseHumanAmountToMinorUnits('1', 1.5)).toBeNull();
    expect(parseHumanAmountToMinorUnits('1', 37)).toBeNull();
  });

  it('round-trips exactly with formatMinorUnits for every registered asset', () => {
    for (const decimals of Object.values(KNOMOSIS_ASSET_DECIMALS)) {
      for (const human of ['1.5', '0.25', '123456.789', '7']) {
        const minor = parseHumanAmountToMinorUnits(human, decimals);
        if (minor !== null) {
          expect(formatMinorUnits(minor, decimals)).toBe(human.replace(/0+$/, ''));
        }
      }
    }
  });

  it('keeps large amounts exact beyond IEEE double precision', () => {
    // 2^53 + 1 is not representable as a double; string math keeps it exact.
    expect(parseHumanAmountToMinorUnits('9007199254740993', 0)).toBe('9007199254740993');
    expect(parseHumanAmountToMinorUnits('9007199254740.993', 3)).toBe('9007199254740993');
  });
});
