// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.3.2a — §17.7 action budgets over the pure @licio/governance math.
// Budgets are anti-spam CAPACITY, never a status or ranking asset: there is no
// transfer path (no such function exists anywhere), budget values never leave
// the knomosis bounded context, and the ranking feature store cannot reach
// this table (WS-D.3.2 isolation).  Charges are optimistic-CAS loops so a
// concurrent double-spend of the same units loses the write and re-reads.

import { type ActionBudgetRules, chargeActionBudget, refillBudget } from '@licio/governance';
import type { ActionBudgetStatus } from '@licio/shared';
import { type TreasuryGovernanceError, tgErr } from './profile.js';
import type { ActionBudgetRecord, ActionBudgetStore } from './stores.js';

export interface BudgetDeps {
  budgets: ActionBudgetStore;
  now: () => number;
  uuid: () => string;
}

const MAX_CAS_RETRIES = 8;

/** The §17.7 default when the law-pack configures no budget rules: budgeted
 *  actions are FREE (a room without budget rules has no capacity mechanism),
 *  but the structure exists so enabling rules later needs no migration. */
export const NO_BUDGET_RULES: ActionBudgetRules = {
  costs: {},
  refill: { periodSeconds: 86_400, units: 0, max: 0 },
};

/**
 * Charge one budgeted action for a (room, user).  Atomic with acceptance by
 * CONTRACT: the caller charges FIRST and only proceeds on success, and the
 * charge itself is an optimistic-CAS loop (a lost race re-reads and retries,
 * so units are never double-spent or phantom-spent).
 */
export async function chargeRoomActionBudget(
  deps: BudgetDeps,
  input: { roomId: string; userId: string; actionType: string; rules: ActionBudgetRules },
): Promise<TreasuryGovernanceError | { ok: true; charged: number; remaining: number }> {
  const cost = input.rules.costs[input.actionType] ?? 0;
  if (cost === 0) return { ok: true, charged: 0, remaining: Number.MAX_SAFE_INTEGER };
  const actorKey = `user:${input.userId}`;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const nowMs = deps.now();
    const existing = await deps.budgets.get(input.roomId, actorKey);
    const state =
      existing === null
        ? // A fresh subject starts at the refill maximum (full capacity).
          { availableUnits: input.rules.refill.max, lastRefillAtMs: nowMs }
        : {
            availableUnits: existing.availableUnits,
            lastRefillAtMs: Date.parse(existing.lastRefillAt),
          };
    const result = chargeActionBudget(state, input.rules, input.actionType, nowMs);
    if (!result.ok) {
      return tgErr(
        409,
        'insufficient_budget',
        `This action costs ${result.required} budget units; ${result.available} available. ` +
          'Budget refills on the law-pack schedule.',
      );
    }
    const record: ActionBudgetRecord = {
      budgetId: existing?.budgetId ?? deps.uuid(),
      roomId: input.roomId,
      actorKey,
      availableUnits: result.state.availableUnits,
      lastRefillAt: new Date(result.state.lastRefillAtMs).toISOString(),
      rateLimitState: existing?.rateLimitState ?? null,
      updatedAt: new Date(nowMs).toISOString(),
    };
    const written = await deps.budgets.put(record, existing?.updatedAt ?? null);
    if (written !== null) {
      return { ok: true, charged: result.charged, remaining: result.state.availableUnits };
    }
  }
  return tgErr(409, 'budget_contended', 'The action budget is busy; please retry.');
}

/** Credit BACK a charge whose side effect turned out to be a duplicate
 *  (the idempotent-create race loser): CAS-guarded, capped at the refill max
 *  so a refund can never mint capacity beyond the budget ceiling. */
export async function refundActionBudget(
  deps: BudgetDeps,
  input: { roomId: string; userId: string; units: number; rules: ActionBudgetRules },
): Promise<void> {
  if (input.units <= 0) return;
  const actorKey = `user:${input.userId}`;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = await deps.budgets.get(input.roomId, actorKey);
    if (existing === null) return; // nothing was ever charged
    const written = await deps.budgets.put(
      {
        ...existing,
        availableUnits: Math.min(input.rules.refill.max, existing.availableUnits + input.units),
        updatedAt: new Date(deps.now()).toISOString(),
      },
      existing.updatedAt,
    );
    if (written !== null) return;
  }
}

/** The §17.7 status view (consumption shown BEFORE signing). */
export async function actionBudgetStatus(
  deps: BudgetDeps,
  input: { roomId: string; userId: string; rules: ActionBudgetRules },
): Promise<ActionBudgetStatus> {
  const existing = await deps.budgets.get(input.roomId, `user:${input.userId}`);
  const nowMs = deps.now();
  const state =
    existing === null
      ? { availableUnits: input.rules.refill.max, lastRefillAtMs: nowMs }
      : refillBudget(
          {
            availableUnits: existing.availableUnits,
            lastRefillAtMs: Date.parse(existing.lastRefillAt),
          },
          input.rules,
          nowMs,
        );
  return {
    room_id: input.roomId,
    available_units: state.availableUnits,
    costs: { ...input.rules.costs },
    transferable: false,
  };
}
