// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.3.2a — §17.7 action-budget arithmetic.  Budgets are an anti-spam and
// capacity mechanism, NEVER a social-status or ranking asset: nothing here (or
// anywhere) exposes budget levels to ranking, and budgets are not transferable
// (no transfer function exists by construction).  Pure integer math: refill is
// computed deterministically from elapsed whole periods, so replaying the same
// inputs always yields the same balance — no wall-clock reads.

import type { ActionBudgetRules } from './schemas/law-pack.js';

export interface BudgetState {
  /** Available whole units (never negative). */
  availableUnits: number;
  /** Epoch ms of the last applied refill boundary. */
  lastRefillAtMs: number;
}

/**
 * Apply the deterministic refill: `refill.units` per ELAPSED WHOLE
 * `refill.periodSeconds`, capped at `refill.max`.  The refill boundary advances
 * only by whole periods so partial periods are never lost or double-counted.
 */
export function refillBudget(
  state: BudgetState,
  rules: ActionBudgetRules,
  nowMs: number,
): BudgetState {
  const periodMs = rules.refill.periodSeconds * 1000;
  if (nowMs <= state.lastRefillAtMs || periodMs <= 0) return state;
  const elapsedPeriods = Math.floor((nowMs - state.lastRefillAtMs) / periodMs);
  if (elapsedPeriods <= 0) return state;
  const refilled = Math.min(
    rules.refill.max,
    state.availableUnits + elapsedPeriods * rules.refill.units,
  );
  return {
    availableUnits: refilled,
    lastRefillAtMs: state.lastRefillAtMs + elapsedPeriods * periodMs,
  };
}

export type BudgetChargeResult =
  | { ok: true; state: BudgetState; charged: number }
  | { ok: false; code: 'insufficient_budget'; required: number; available: number };

/**
 * Charge one action against the budget (refill first, then debit).  An action
 * type with no configured cost is FREE (basic civic actions never consume
 * budget, §17.7); a configured cost of 0 is also free.  Atomicity with the
 * action itself is the caller's job (charge + accept in one store transaction).
 */
export function chargeActionBudget(
  state: BudgetState,
  rules: ActionBudgetRules,
  actionType: string,
  nowMs: number,
): BudgetChargeResult {
  const refreshed = refillBudget(state, rules, nowMs);
  const cost = rules.costs[actionType] ?? 0;
  if (cost === 0) return { ok: true, state: refreshed, charged: 0 };
  if (refreshed.availableUnits < cost) {
    return {
      ok: false,
      code: 'insufficient_budget',
      required: cost,
      available: refreshed.availableUnits,
    };
  }
  return {
    ok: true,
    state: { ...refreshed, availableUnits: refreshed.availableUnits - cost },
    charged: cost,
  };
}
