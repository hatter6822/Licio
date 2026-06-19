// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  checkInvestmentBands,
  evaluateTreasuryAction,
  type TreasuryHistoryEntry,
} from '../kernel.js';
import type { TreasuryBounds } from '../schemas/law-pack.js';
import type { TreasuryAction } from '../schemas/treasury.js';

const NOW = '2026-06-19T12:00:00.000Z';

const bounds: TreasuryBounds = {
  caps: [
    {
      category: 'member_distribution',
      perActionMax: 100,
      perWindowMax: 250,
      windowSeconds: 86_400,
    },
    { category: 'grant', perActionMax: 500, perWindowMax: 500, windowSeconds: 86_400 },
    {
      category: 'investment_rebalance',
      perActionMax: 1000,
      perWindowMax: 1000,
      windowSeconds: 86_400,
    },
  ],
  minIntervalSeconds: 60,
  timelockSeconds: 3600,
  materialThreshold: 100,
  requireCoiFor: ['grant'],
  investment: {
    allocationBands: [
      { asset: 'STABLE', minFraction: 0.5, maxFraction: 1 },
      { asset: 'ETH', minFraction: 0, maxFraction: 0.5 },
    ],
    rebalanceMinIntervalSeconds: 86_400,
  },
};

function action(over: Partial<TreasuryAction> = {}): TreasuryAction {
  return {
    actionId: 'a1',
    roomId: 'r1',
    category: 'member_distribution',
    amount: 50,
    asset: 'USDC',
    timestamp: NOW,
    proposedAt: NOW,
    coiDeclared: false,
    proposalRef: null,
    ...over,
  };
}

const opts = { cryptoEnabled: true, now: NOW };

describe('evaluateTreasuryAction', () => {
  it('rejects fail-closed when crypto is disabled', () => {
    const v = evaluateTreasuryAction(action(), bounds, [], { cryptoEnabled: false, now: NOW });
    expect(v).toMatchObject({ accepted: false, code: 'crypto_disabled' });
  });

  it('accepts a within-bounds action with satisfied-precondition evidence', () => {
    const v = evaluateTreasuryAction(action(), bounds, [], opts);
    expect(v.accepted).toBe(true);
    if (v.accepted) {
      expect(v.evidence.checks.map((c) => c.name)).toContain('per_window_cap');
      expect(v.evidence.checks.every((c) => c.passed)).toBe(true);
    }
  });

  it('rejects an unconfigured category', () => {
    const v = evaluateTreasuryAction(action({ category: 'bounty' }), bounds, [], opts);
    expect(v).toMatchObject({ accepted: false, code: 'no_cap_configured' });
  });

  it('rejects per-action and per-window cap breaches', () => {
    expect(evaluateTreasuryAction(action({ amount: 200 }), bounds, [], opts)).toMatchObject({
      code: 'per_action_cap_exceeded',
    });
    const history: TreasuryHistoryEntry[] = [
      { category: 'member_distribution', amount: 200, timestamp: '2026-06-19T06:00:00.000Z' },
    ];
    expect(evaluateTreasuryAction(action({ amount: 100 }), bounds, history, opts)).toMatchObject({
      code: 'per_window_cap_exceeded',
    });
  });

  it('rejects a minimum-interval breach', () => {
    const history: TreasuryHistoryEntry[] = [
      { category: 'member_distribution', amount: 10, timestamp: '2026-06-19T11:59:30.000Z' },
    ];
    expect(evaluateTreasuryAction(action(), bounds, history, opts)).toMatchObject({
      code: 'min_interval_violated',
    });
  });

  it('rejects a material action inside its timelock', () => {
    const v = evaluateTreasuryAction(action({ amount: 100, proposedAt: NOW }), bounds, [], opts);
    expect(v).toMatchObject({ accepted: false, code: 'timelock_not_elapsed' });
  });

  it('requires a COI declaration where the law-pack demands one', () => {
    const grant = action({ category: 'grant', amount: 50, coiDeclared: false });
    expect(evaluateTreasuryAction(grant, bounds, [], opts)).toMatchObject({ code: 'coi_required' });
    const declared = action({ category: 'grant', amount: 50, coiDeclared: true });
    expect(evaluateTreasuryAction(declared, bounds, [], opts).accepted).toBe(true);
  });

  it('enforces the investment rebalance interval', () => {
    const history: TreasuryHistoryEntry[] = [
      { category: 'investment_rebalance', amount: 0, timestamp: '2026-06-19T11:00:00.000Z' },
    ];
    const rebal = action({ category: 'investment_rebalance', amount: 0, coiDeclared: true });
    expect(evaluateTreasuryAction(rebal, bounds, history, opts)).toMatchObject({
      code: 'investment_interval_violated',
    });
  });
});

describe('checkInvestmentBands', () => {
  const policy = bounds.investment;
  if (!policy) throw new Error('policy required');

  it('accepts an in-band, sum-bounded allocation', () => {
    expect(
      checkInvestmentBands(
        [
          { asset: 'STABLE', fraction: 0.6 },
          { asset: 'ETH', fraction: 0.4 },
        ],
        policy,
      ).accepted,
    ).toBe(true);
  });

  it('rejects an out-of-band asset', () => {
    expect(checkInvestmentBands([{ asset: 'ETH', fraction: 0.6 }], policy)).toMatchObject({
      code: 'investment_band_violated',
    });
  });

  it('rejects an unknown asset and an over-allocated total', () => {
    expect(checkInvestmentBands([{ asset: 'DOGE', fraction: 0.1 }], policy).accepted).toBe(false);
    expect(
      checkInvestmentBands(
        [
          { asset: 'STABLE', fraction: 0.8 },
          { asset: 'ETH', fraction: 0.5 },
        ],
        policy,
      ),
    ).toMatchObject({ code: 'investment_band_violated' });
  });
});
