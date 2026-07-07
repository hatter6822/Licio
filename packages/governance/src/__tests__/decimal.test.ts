// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exact decimal arithmetic (decimal.ts) — the mathematical-soundness backbone of
// kernel cap comparisons.  Covers: exactness beyond 2^53, uint256-scale strings,
// exponent-form number inputs, fraction alignment, canonical rendering, and the
// kernel's own regression (a wei-scale cap must not round through a double).

import { describe, expect, it } from 'vitest';
import {
  decAdd,
  decCompare,
  decIsNegative,
  decSum,
  isDecimalString,
  isValidDecimal,
} from '../decimal.js';
import { evaluateTreasuryAction } from '../kernel.js';
import type { TreasuryBounds } from '../schemas/law-pack.js';

describe('isDecimalString / isValidDecimal', () => {
  it('accepts plain, fractional, signed, and exponent forms', () => {
    for (const v of ['0', '42', '0.1', '-3.25', '+7', '1e21', '1.5e-7', '1E+3']) {
      expect(isDecimalString(v), v).toBe(true);
    }
  });

  it('rejects garbage, empty, hex, NaN, and Infinity', () => {
    for (const v of ['', ' ', '0x10', '1.', '.5', '1..2', 'NaN', 'Infinity', '1e', '--1']) {
      expect(isDecimalString(v), v).toBe(false);
    }
    expect(isValidDecimal(Number.NaN)).toBe(false);
    expect(isValidDecimal(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidDecimal(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe('decCompare', () => {
  it('is exact where IEEE doubles are not (2^53 boundary)', () => {
    // 2^53 = 9007199254740992; +1 is unrepresentable as a double.
    expect(decCompare('9007199254740993', '9007199254740992')).toBe(1);
    // The double failure the string path avoids: parsing both collapses them.
    expect(Number('9007199254740993') === Number('9007199254740992')).toBe(true);
  });

  it('is exact for uint256-scale (78-digit) strings', () => {
    const max = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    const maxMinus1 =
      '115792089237316195423570985008687907853269984665640564039457584007913129639934';
    expect(decCompare(max, maxMinus1)).toBe(1);
    expect(decCompare(maxMinus1, max)).toBe(-1);
    expect(decCompare(max, max)).toBe(0);
  });

  it('aligns fractional scales exactly', () => {
    expect(decCompare('0.1', '0.10')).toBe(0);
    expect(decCompare('0.3', decAdd('0.1', '0.2'))).toBe(0); // no 0.30000000000000004
    expect(decCompare('1.05', '1.5')).toBe(-1);
  });

  it('handles mixed number/string inputs and exponent forms', () => {
    expect(decCompare(1e21, '1000000000000000000000')).toBe(0);
    expect(decCompare(1.5e-7, '0.00000015')).toBe(0);
    expect(decCompare(10, '9.999999999')).toBe(1);
  });

  it('orders signed values correctly', () => {
    expect(decCompare('-1', '1')).toBe(-1);
    expect(decCompare('-0', '0')).toBe(0);
    expect(decCompare('-2.5', '-2.4')).toBe(-1);
  });
});

describe('decAdd / decSum', () => {
  it('adds exactly with scale alignment and canonical rendering', () => {
    expect(decAdd('0.1', '0.2')).toBe('0.3');
    expect(decAdd('1', '0.05')).toBe('1.05');
    expect(decAdd('2.50', '0.50')).toBe('3');
    expect(decAdd('-1.25', '1.25')).toBe('0');
  });

  it('sums wei-scale values without loss', () => {
    const wei = '1000000000000000000'; // 1 ETH in wei
    expect(decSum([wei, wei, wei])).toBe('3000000000000000000');
    expect(decSum([])).toBe('0');
  });

  it('never renders -0 and trims trailing zeros', () => {
    expect(decAdd('0.10', '-0.10')).toBe('0');
    expect(decAdd('1.100', '0')).toBe('1.1');
  });
});

describe('decIsNegative', () => {
  it('detects sign, treating -0 as non-negative', () => {
    expect(decIsNegative('-1')).toBe(true);
    expect(decIsNegative('-0.0001')).toBe(true);
    expect(decIsNegative('-0')).toBe(false);
    expect(decIsNegative('0')).toBe(false);
    expect(decIsNegative(3)).toBe(false);
  });
});

describe('kernel regression: exact caps at wei scale', () => {
  const bounds: TreasuryBounds = {
    caps: [
      {
        category: 'grant',
        // 2^53 wei: the classic double-rounding boundary.
        perActionMax: '9007199254740992',
        perWindowMax: '9007199254740993',
        windowSeconds: 3600,
      },
    ],
    minIntervalSeconds: 0,
    timelockSeconds: 0,
    materialThreshold: '9007199254740993',
    requireCoiFor: [],
    investment: null,
  };
  const base = {
    actionId: 'a1',
    roomId: 'r1',
    category: 'grant' as const,
    asset: 'WEI',
    timestamp: '2026-07-06T00:00:00.000Z',
    proposedAt: '2026-07-06T00:00:00.000Z',
    coiDeclared: false,
    proposalRef: null,
    targetAllocation: null,
  };
  const options = { cryptoEnabled: true, now: '2026-07-06T00:00:01.000Z' };

  it('rejects one unit above the per-action cap even where doubles collapse', () => {
    // As doubles, 9007199254740993 === 9007199254740992 — the old float compare
    // would have ACCEPTED this over-cap action.
    const verdict = evaluateTreasuryAction(
      { ...base, amount: '9007199254740993' },
      bounds,
      [],
      options,
    );
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.code).toBe('per_action_cap_exceeded');
  });

  it('accepts exactly at the cap and enforces the window sum exactly', () => {
    const atCap = evaluateTreasuryAction({ ...base, amount: '9007199254740992' }, bounds, [], {
      ...options,
    });
    expect(atCap.accepted).toBe(true);

    // History of 2 units; window max allows only 1 more unit beyond 2^53 − 1.
    const overWindow = evaluateTreasuryAction(
      { ...base, amount: '9007199254740992' },
      bounds,
      [{ category: 'grant', amount: '2', timestamp: '2026-07-06T00:00:00.500Z' }],
      options,
    );
    expect(overWindow.accepted).toBe(false);
    if (!overWindow.accepted) expect(overWindow.code).toBe('per_window_cap_exceeded');
  });

  it('rejects malformed and negative string amounts fail-closed', () => {
    for (const amount of ['-1', 'abc', '']) {
      const verdict = evaluateTreasuryAction({ ...base, amount }, bounds, [], options);
      expect(verdict.accepted).toBe(false);
      if (!verdict.accepted) expect(verdict.code).toBe('invalid_amount');
    }
  });
});
