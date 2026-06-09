// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Return-visit + thread-traversal tracker (WS-C.4.3, SPEC §5.3/§6.7). A return
// visit is a revisit after a time-away threshold (sustained interest). A
// RAGE-LOOP — too many returns inside a short window — is dampened to ZERO so a
// hostile/compulsive loop never increases positive attention (SIG-ANTI-RAGELOOP,
// §6.7). Thread traversal counts DISTINCT branches visited, so nonredundant
// exploration is weighted above re-reading the same branch.

export interface ReturnTrackerConfig {
  /** Minimum time away before a revisit counts as a return (default 30 min). */
  returnThresholdMs: number;
  /** Window over which returns are tallied for rage-loop detection (default 1h). */
  rageWindowMs: number;
  /** Returns within the window at/above which the loop is dampened to 0. */
  rageCount: number;
}

const DEFAULT_CONFIG: ReturnTrackerConfig = {
  returnThresholdMs: 30 * 60_000,
  // 3 returns at the minimum 30-min spacing span 60 min; a 90-min window catches
  // that max-rate obsessive pattern while a genuine occasional return does not.
  rageWindowMs: 90 * 60_000,
  rageCount: 3,
};

interface ItemReturns {
  lastVisitAt: number;
  returnCount: number;
  /** Timestamps of genuine returns, pruned to the rage window. */
  returnTimes: number[];
}

export class ReturnTracker {
  private readonly config: ReturnTrackerConfig;
  private readonly items = new Map<string, ItemReturns>();

  constructor(config: Partial<ReturnTrackerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Record a visit. A visit ≥ threshold after the previous one is a return. */
  visit(itemId: string, now: number): void {
    const state = this.items.get(itemId) ?? {
      lastVisitAt: Number.NEGATIVE_INFINITY,
      returnCount: 0,
      returnTimes: [],
    };
    if (
      state.lastVisitAt !== Number.NEGATIVE_INFINITY &&
      now - state.lastVisitAt >= this.config.returnThresholdMs
    ) {
      state.returnCount += 1;
      state.returnTimes.push(now);
    }
    state.returnTimes = state.returnTimes.filter((t) => now - t < this.config.rageWindowMs);
    state.lastVisitAt = now;
    this.items.set(itemId, state);
  }

  /** True when returns within the window have reached the rage threshold. */
  isRageLoop(itemId: string): boolean {
    return (this.items.get(itemId)?.returnTimes.length ?? 0) >= this.config.rageCount;
  }

  /**
   * Genuine return count for the aggregate: the raw count, but ZERO when the
   * item is in a rage loop (compulsive returns are not rewarded, §6.7).
   */
  returnCount(itemId: string): number {
    const state = this.items.get(itemId);
    if (!state) return 0;
    return this.isRageLoop(itemId) ? 0 : state.returnCount;
  }

  resetSession(): void {
    this.items.clear();
  }
}

/** Distinct-branch traversal per thread (nonredundant exploration). */
export class TraversalTracker {
  private readonly branchesByThread = new Map<string, Set<string>>();

  /** Record a branch visit. Revisiting the same branch does not raise the count. */
  visitBranch(threadId: string, branchId: string): void {
    const set = this.branchesByThread.get(threadId) ?? new Set<string>();
    set.add(branchId);
    this.branchesByThread.set(threadId, set);
  }

  /** Number of DISTINCT branches visited in a thread. */
  distinctBranches(threadId: string): number {
    return this.branchesByThread.get(threadId)?.size ?? 0;
  }

  resetSession(): void {
    this.branchesByThread.clear();
  }
}
