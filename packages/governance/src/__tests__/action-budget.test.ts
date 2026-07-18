// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { type BudgetState, chargeActionBudget, refillBudget } from '../action-budget.js';
import type { ActionBudgetRules } from '../schemas/law-pack.js';

const rules: ActionBudgetRules = {
  costs: { proposal_submission: 5, treasury_operation: 10, law_pack_change: 20 },
  refill: { periodSeconds: 3_600, units: 5, max: 50 },
};

const T0 = Date.parse('2026-07-01T00:00:00.000Z');
const state = (availableUnits: number, lastRefillAtMs = T0): BudgetState => ({
  availableUnits,
  lastRefillAtMs,
});

describe('refillBudget (WS-M.3.2a / §17.7)', () => {
  it('adds units per elapsed whole period, capped at max', () => {
    const next = refillBudget(state(10), rules, T0 + 2 * 3_600_000);
    expect(next.availableUnits).toBe(20);
    expect(next.lastRefillAtMs).toBe(T0 + 2 * 3_600_000);
  });

  it('never exceeds the cap', () => {
    const next = refillBudget(state(48), rules, T0 + 3 * 3_600_000);
    expect(next.availableUnits).toBe(50);
  });

  it('ignores partial periods and preserves the boundary for later accrual', () => {
    const next = refillBudget(state(10), rules, T0 + 90 * 60_000); // 1.5 periods
    expect(next.availableUnits).toBe(15);
    expect(next.lastRefillAtMs).toBe(T0 + 3_600_000); // advanced ONE whole period
  });

  it('is a no-op when time has not advanced (or went backwards)', () => {
    expect(refillBudget(state(10), rules, T0)).toEqual(state(10));
    expect(refillBudget(state(10), rules, T0 - 1)).toEqual(state(10));
  });

  it('is deterministic: split refills equal one combined refill', () => {
    const oneShot = refillBudget(state(0), rules, T0 + 5 * 3_600_000);
    const stepped = refillBudget(
      refillBudget(state(0), rules, T0 + 2 * 3_600_000),
      rules,
      T0 + 5 * 3_600_000,
    );
    expect(stepped).toEqual(oneShot);
  });
});

describe('chargeActionBudget (WS-M.3.2a)', () => {
  it('debits the configured cost for budgeted actions', () => {
    const result = chargeActionBudget(state(10), rules, 'proposal_submission', T0);
    expect(result).toMatchObject({ ok: true, charged: 5 });
    if (result.ok) expect(result.state.availableUnits).toBe(5);
  });

  it('never charges basic civic actions (unconfigured types are free)', () => {
    const result = chargeActionBudget(state(0), rules, 'read_story', T0);
    expect(result).toMatchObject({ ok: true, charged: 0 });
  });

  it('blocks with a typed error when the budget is insufficient', () => {
    const result = chargeActionBudget(state(3), rules, 'proposal_submission', T0);
    expect(result).toMatchObject({
      ok: false,
      code: 'insufficient_budget',
      required: 5,
      available: 3,
    });
  });

  it('refills before charging, so an accrued budget covers the action', () => {
    const result = chargeActionBudget(state(3), rules, 'proposal_submission', T0 + 3_600_000);
    expect(result).toMatchObject({ ok: true, charged: 5 });
    if (result.ok) expect(result.state.availableUnits).toBe(3); // 3 + 5 − 5
  });
});
