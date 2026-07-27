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

import { decCompare, decIsNegative, decSum, isValidDecimal } from './decimal.js';
import type { InvestmentPolicy, TreasuryBounds, TreasuryCategory } from './schemas/law-pack.js';
import type { ProofCheck, TreasuryAction, Verdict } from './schemas/treasury.js';

/** A prior executed treasury action, for window/interval accounting.  Amounts
 *  are `number | string`; all kernel arithmetic is exact decimal (`decimal.ts`),
 *  so a 78-digit uint256 minor-unit string compares without precision loss. */
export interface TreasuryHistoryEntry {
  category: TreasuryCategory;
  amount: number | string;
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
  // a non-finite (NaN/±Infinity), malformed, or negative amount would make every
  // cap comparison silently pass, so reject it up front (fail-closed).  All
  // arithmetic below is exact decimal math — never IEEE floats — so minor-unit
  // (wei-scale) string amounts above 2^53 stay mathematically sound.
  if (!isValidDecimal(action.amount) || decIsNegative(action.amount)) {
    return {
      accepted: false,
      code: 'invalid_amount',
      reason: 'The treasury action amount must be a finite, non-negative decimal.',
    };
  }
  // EVERY decimal the arithmetic below touches gets the same guard, not just the
  // action's own amount.  `decSum`/`decCompare` THROW on a value outside the
  // decimal domain, so an unparseable history amount or law-pack bound would
  // escape as an exception rather than the typed verdict this function promises
  // — the caller's transition would fail on an unrelated error path instead of a
  // `Verdict`.  The timestamp guard below already covers history for exactly
  // this reason; amounts get the symmetric treatment.
  const comparedAmounts: ReadonlyArray<number | string> = [
    ...history.map((h) => h.amount),
    ...bounds.caps.flatMap((c) => [c.perActionMax, c.perWindowMax]),
    bounds.materialThreshold,
  ];
  if (!comparedAmounts.every((value) => isValidDecimal(value))) {
    return {
      accepted: false,
      code: 'invalid_amount',
      reason:
        'Every treasury amount (history entries and law-pack bounds) must be a finite decimal.',
    };
  }

  // Self-guard every timestamp the same fail-closed way: `Date.parse` returns NaN
  // for a malformed instant, and every NaN comparison in the window/interval/
  // timelock checks below is silently false — so a bad `now`, `proposedAt`, or
  // history timestamp would make those preconditions VACUOUSLY pass.  Reject up
  // front rather than honor an un-timeable action.
  if (
    !Number.isFinite(ms(options.now)) ||
    !Number.isFinite(ms(action.proposedAt)) ||
    history.some((h) => !Number.isFinite(ms(h.timestamp)))
  ) {
    return {
      accepted: false,
      code: 'invalid_timestamp',
      reason:
        'Every treasury timestamp (now, proposedAt, and history entries) must be a valid instant.',
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

  if (decCompare(action.amount, cap.perActionMax) > 0) {
    return {
      accepted: false,
      code: 'per_action_cap_exceeded',
      reason: `Amount ${action.amount} exceeds the per-action maximum ${cap.perActionMax}.`,
    };
  }
  checks.push({ name: 'per_action_cap', passed: true });

  const nowMs = ms(options.now);
  const windowStart = nowMs - cap.windowSeconds * 1000;
  const windowTotal = decSum([
    ...history
      .filter((h) => h.category === action.category && ms(h.timestamp) >= windowStart)
      .map((h) => h.amount),
    action.amount,
  ]);
  if (decCompare(windowTotal, cap.perWindowMax) > 0) {
    return {
      accepted: false,
      code: 'per_window_cap_exceeded',
      reason: `Window total ${windowTotal} exceeds the per-window maximum ${cap.perWindowMax}.`,
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

  if (decCompare(action.amount, bounds.materialThreshold) >= 0 && bounds.timelockSeconds > 0) {
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
 * Validate a proposed treasury allocation against the investment policy bands.
 * The proposed entries are AGGREGATED per asset first (duplicate entries for the
 * same asset sum), then EVERY policy band is checked — an asset absent from the
 * allocation has an effective total of 0, which must still satisfy the band's
 * minimum (so a policy floor like `STABLE >= 0.5` cannot be evaded by simply
 * omitting the asset). An allocated asset with no matching band, a per-asset total
 * outside its [min,max], or a grand total above 1 all reject. Used when an
 * investment rebalance specifies a target allocation (ADR-4 — room-treasury scope).
 */
export function checkInvestmentBands(
  allocation: readonly TargetAllocation[],
  policy: InvestmentPolicy,
): Verdict {
  // A NON-FINITE fraction has to die here, before it reaches any comparison.
  // Every comparison against NaN is false, so a NaN fraction passes BOTH band
  // bounds AND the grand-total guard below — the function would return
  // `accepted: true` carrying an `investment_bands passed` proof for an
  // allocation that satisfies no band at all.  That is the same vacuous-pass
  // failure `evaluateTreasuryAction` rejects `action.amount` for; the bands are
  // a machine-checkable proof and must fail closed on an uncheckable input.
  for (const a of allocation) {
    if (!Number.isFinite(a.fraction)) {
      return {
        accepted: false,
        code: 'investment_band_violated',
        reason: `Asset ${a.asset} has a non-finite allocation fraction.`,
      };
    }
  }
  // The BAND EDGES are the other half of every comparison and fail exactly the
  // same way: a NaN `maxFraction` makes `total > max + EPSILON` false, so the
  // band admits any allocation.  An uncheckable policy cannot yield a proof.
  for (const band of policy.allocationBands) {
    if (!Number.isFinite(band.minFraction) || !Number.isFinite(band.maxFraction)) {
      return {
        accepted: false,
        code: 'investment_band_violated',
        reason: `Asset ${band.asset} has a non-finite policy band.`,
      };
    }
  }
  // Aggregate the proposed entries per asset (duplicates sum), rejecting any asset
  // the policy does not define a band for.
  const totals = new Map<string, number>();
  for (const a of allocation) {
    if (!policy.allocationBands.some((b) => b.asset === a.asset)) {
      return {
        accepted: false,
        code: 'investment_band_violated',
        reason: `Asset ${a.asset} is not in the room's investment policy.`,
      };
    }
    totals.set(a.asset, (totals.get(a.asset) ?? 0) + a.fraction);
  }
  // EVERY band must hold — including minimums for assets omitted from the proposal.
  // Fractions are summed floats, so compare with the SAME epsilon tolerance the
  // grand-total check below uses — otherwise a band-edge allocation (e.g.
  // 0.1 + 0.2 = 0.30000000000000004) fails the exact per-band check while the
  // grand total accepts it (an inconsistency that rejected valid proposals).
  const EPSILON = 1e-9;
  let sum = 0;
  for (const band of policy.allocationBands) {
    const total = totals.get(band.asset) ?? 0;
    if (total < band.minFraction - EPSILON || total > band.maxFraction + EPSILON) {
      return {
        accepted: false,
        code: 'investment_band_violated',
        reason: `Asset ${band.asset} allocation ${total} is outside its permitted band [${band.minFraction}, ${band.maxFraction}].`,
      };
    }
  }
  for (const total of totals.values()) sum += total;
  if (sum > 1 + EPSILON) {
    return {
      accepted: false,
      code: 'investment_band_violated',
      reason: `Total allocation ${sum} exceeds 1.`,
    };
  }
  return { accepted: true, evidence: { checks: [{ name: 'investment_bands', passed: true }] } };
}
