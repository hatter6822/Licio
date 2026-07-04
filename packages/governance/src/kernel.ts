// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U GovernanceKernel (SPEC §17.6, §24.6; ADR-2/4). The deterministic, in-
// process implementation of the proof-carrying treasury semantics: an action is
// accepted IFF it carries machine-checkable evidence it satisfies the law-pack
// preconditions (caps, window totals, interval, timelock, COI, investment bands),
// else it is rejected with a typed code. The agent holds no keys; the kernel —
// not the model — is the executor. This same contract is the `KnomosisGateway`
// seam the real Lean/Solidity/Rust deployment plugs into later. Pure: all state
// (history, clock, crypto flag) is passed in, so serving and replay cannot drift.

import type { InvestmentPolicy, TreasuryBounds, TreasuryCategory } from './schemas/law-pack.js';
import type { ProofCheck, TreasuryAction, Verdict } from './schemas/treasury.js';

/** A prior executed treasury action, for window/interval accounting. */
export interface TreasuryHistoryEntry {
  category: TreasuryCategory;
  amount: number;
  /** ISO-8601 execution time. */
  timestamp: string;
}

export interface KernelOptions {
  /** Fail-closed: when false, every treasury action is rejected. */
  cryptoEnabled: boolean;
  /** ISO-8601 evaluation time (passed in for determinism). */
  now: string;
}

function ms(iso: string): number {
  return Date.parse(iso);
}

/**
 * Evaluate a treasury action against the law-pack bounds. Returns an accept
 * verdict carrying the satisfied-precondition evidence, or the first failing
 * precondition as a typed rejection. Checks are ordered cheapest-first.
 */
export function evaluateTreasuryAction(
  action: TreasuryAction,
  bounds: TreasuryBounds,
  history: readonly TreasuryHistoryEntry[],
  options: KernelOptions,
): Verdict {
  if (!options.cryptoEnabled) {
    return {
      accepted: false,
      code: 'crypto_disabled',
      reason: 'Crypto features are disabled (fail-closed); no treasury action executes.',
    };
  }

  // Self-guard the proof-carrying contract independent of any front-door schema:
  // a non-finite (NaN/±Infinity) or negative amount would make every cap
  // comparison silently pass, so reject it up front (fail-closed).
  if (!Number.isFinite(action.amount) || action.amount < 0) {
    return {
      accepted: false,
      code: 'invalid_amount',
      reason: 'The treasury action amount must be a finite, non-negative number.',
    };
  }

  const checks: ProofCheck[] = [];
  const cap = bounds.caps.find((c) => c.category === action.category);
  if (!cap) {
    return {
      accepted: false,
      code: 'no_cap_configured',
      reason: `No spend cap configured for category "${action.category}".`,
    };
  }
  checks.push({ name: 'category_permitted', passed: true });

  if (action.amount > cap.perActionMax) {
    return {
      accepted: false,
      code: 'per_action_cap_exceeded',
      reason: `Amount ${action.amount} exceeds the per-action maximum ${cap.perActionMax}.`,
    };
  }
  checks.push({ name: 'per_action_cap', passed: true });

  const nowMs = ms(options.now);
  const windowStart = nowMs - cap.windowSeconds * 1000;
  const windowSum = history
    .filter((h) => h.category === action.category && ms(h.timestamp) >= windowStart)
    .reduce((sum, h) => sum + h.amount, 0);
  if (windowSum + action.amount > cap.perWindowMax) {
    return {
      accepted: false,
      code: 'per_window_cap_exceeded',
      reason: `Window total ${windowSum + action.amount} exceeds the per-window maximum ${cap.perWindowMax}.`,
    };
  }
  checks.push({ name: 'per_window_cap', passed: true });

  if (bounds.minIntervalSeconds > 0 && history.length > 0) {
    const lastMs = Math.max(...history.map((h) => ms(h.timestamp)));
    if (nowMs - lastMs < bounds.minIntervalSeconds * 1000) {
      return {
        accepted: false,
        code: 'min_interval_violated',
        reason: `Minimum interval ${bounds.minIntervalSeconds}s not elapsed since the last action.`,
      };
    }
  }
  checks.push({ name: 'min_interval', passed: true });

  if (action.amount >= bounds.materialThreshold && bounds.timelockSeconds > 0) {
    if (nowMs - ms(action.proposedAt) < bounds.timelockSeconds * 1000) {
      return {
        accepted: false,
        code: 'timelock_not_elapsed',
        reason: `Timelock ${bounds.timelockSeconds}s not elapsed for this material action.`,
      };
    }
  }
  checks.push({ name: 'timelock', passed: true });

  if (bounds.requireCoiFor.includes(action.category) && !action.coiDeclared) {
    return {
      accepted: false,
      code: 'coi_required',
      reason: `A conflict-of-interest declaration is required for "${action.category}".`,
    };
  }
  checks.push({ name: 'coi', passed: true });

  if (action.category === 'investment_rebalance' && bounds.investment) {
    const rebalances = history
      .filter((h) => h.category === 'investment_rebalance')
      .map((h) => ms(h.timestamp));
    if (rebalances.length > 0) {
      const last = Math.max(...rebalances);
      if (nowMs - last < bounds.investment.rebalanceMinIntervalSeconds * 1000) {
        return {
          accepted: false,
          code: 'investment_interval_violated',
          reason: 'Investment rebalance interval not elapsed.',
        };
      }
    }
    checks.push({ name: 'investment_interval', passed: true });

    // Enforce the community-voted per-asset allocation bands (fail-closed): a room
    // that has voted an investment policy requires the rebalance to declare a
    // target allocation that satisfies every band. Without this the voted bands
    // would be structurally unenforceable (a rebalance could move 100% into a
    // volatile asset). `checkInvestmentBands` is the machine-checkable proof.
    if (action.targetAllocation === null) {
      return {
        accepted: false,
        code: 'investment_band_required',
        reason:
          'This room has voted an investment policy; a target allocation is required for a rebalance.',
      };
    }
    const bandVerdict = checkInvestmentBands(action.targetAllocation, bounds.investment);
    if (!bandVerdict.accepted) return bandVerdict;
    checks.push({ name: 'investment_bands', passed: true });
  }

  return { accepted: true, evidence: { checks } };
}

export interface TargetAllocation {
  asset: string;
  fraction: number;
}

/**
 * Validate a proposed treasury allocation against the investment policy bands
 * (each asset within [min,max], total ≤ 1). Used when an investment rebalance
 * specifies a target allocation (ADR-4 — room-treasury scope only).
 */
export function checkInvestmentBands(
  allocation: readonly TargetAllocation[],
  policy: InvestmentPolicy,
): Verdict {
  let sum = 0;
  for (const a of allocation) {
    const band = policy.allocationBands.find((b) => b.asset === a.asset);
    if (!band || a.fraction < band.minFraction || a.fraction > band.maxFraction) {
      return {
        accepted: false,
        code: 'investment_band_violated',
        reason: `Asset ${a.asset} allocation ${a.fraction} is outside its permitted band.`,
      };
    }
    sum += a.fraction;
  }
  if (sum > 1 + 1e-9) {
    return {
      accepted: false,
      code: 'investment_band_violated',
      reason: `Total allocation ${sum} exceeds 1.`,
    };
  }
  return { accepted: true, evidence: { checks: [{ name: 'investment_bands', passed: true }] } };
}
