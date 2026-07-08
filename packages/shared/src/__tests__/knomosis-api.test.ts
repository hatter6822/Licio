// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  positiveMinorUnitAmountSchema,
  simTreasuryDepositRequestSchema,
} from '../schemas/knomosis-api.js';

describe('positiveMinorUnitAmountSchema (WS-L.4.1c)', () => {
  it('accepts a strictly positive minor-unit amount', () => {
    for (const a of ['1', '1000000', '9'.repeat(78)]) {
      expect(positiveMinorUnitAmountSchema.safeParse(a).success).toBe(true);
    }
  });

  it('REJECTS zero (and all-zero) amounts', () => {
    for (const a of ['0', '00', '000']) {
      expect(positiveMinorUnitAmountSchema.safeParse(a).success).toBe(false);
    }
  });
});

describe('simTreasuryDepositRequestSchema (M4)', () => {
  it('rejects a zero-amount deposit so it cannot pad the readiness track record', () => {
    expect(
      simTreasuryDepositRequestSchema.safeParse({ asset: 'SIM-USDC', amount: '0' }).success,
    ).toBe(false);
    expect(
      simTreasuryDepositRequestSchema.safeParse({ asset: 'SIM-USDC', amount: '1000000' }).success,
    ).toBe(true);
  });
});
