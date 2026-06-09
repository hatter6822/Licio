// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Return-visit + thread-traversal tracker (WS-C.4.3, SPEC §5.3/§6.7). A return
// visit is a revisit after a time-away threshold (sustained interest). A
// RAGE-LOOP — too many returns inside a short window — PERMANENTLY forfeits the
// returns counted during the burst, so a hostile/compulsive loop never increases
// positive attention even after the window ages out (SIG-ANTI-RAGELOOP, §6.7).
// (A windowed-only suppression would let the burst's returns resurrect into the
// count later — the exact gaming vector this rule closes.) Thread traversal counts
// DISTINCT branches visited, so nonredundant exploration is weighted above
// re-reading the same branch.
//
// Return state is persisted LOCALLY (never uploaded) through an injectable store
// so that a genuine return after the app was closed — and a rage-loop spanning a
// reload — are detected across sessions. Only the bucketed count reaches the
// §22.1 aggregate; the per-visit timestamp series stays on the device.

/** A persistable snapshot of one item's return state (local-only). */
export interface ReturnSnapshot {
  id: string;
  lastVisitAt: number;
  returnCount: number;
  /** Genuine-return timestamps, pruned to the rage window. */
  returnTimes: number[];
  /** Returns permanently forfeited because they occurred inside a rage loop. */
  forfeited: number;
}

/** Local persistence port for return state (no-op by default; localStorage in prod). */
export interface ReturnTrackerStore {
  load(): ReturnSnapshot[] | null;
  save(snapshots: ReturnSnapshot[]): void;
}

const NOOP_STORE: ReturnTrackerStore = { load: () => null, save: () => undefined };

export interface ReturnTrackerConfig {
  /** Minimum time away before a revisit counts as a return (default 30 min). */
  returnThresholdMs: number;
  /** Window over which returns are tallied for rage-loop detection (default 90 min). */
  rageWindowMs: number;
  /** Returns within the window at/above which the loop is dampened to 0. */
  rageCount: number;
  /** Drop items untouched for longer than this; bounds local storage (default 30 days). */
  retentionMs: number;
  /** Max distinct items retained, evicting least-recently-visited (default 500). */
  maxItems: number;
}

const DEFAULT_CONFIG: ReturnTrackerConfig = {
  returnThresholdMs: 30 * 60_000,
  // 3 returns at the minimum 30-min spacing span 60 min; a 90-min window catches
  // that max-rate obsessive pattern while a genuine occasional return does not.
  rageWindowMs: 90 * 60_000,
  rageCount: 3,
  retentionMs: 30 * 24 * 60 * 60_000,
  maxItems: 500,
};

interface ItemReturns {
  lastVisitAt: number;
  returnCount: number;
  /** Timestamps of genuine returns, pruned to the rage window. */
  returnTimes: number[];
  /** Cumulative returns forfeited by rage-loop detection (never decremented). */
  forfeited: number;
}

export class ReturnTracker {
  private readonly config: ReturnTrackerConfig;
  private readonly store: ReturnTrackerStore;
  private readonly items = new Map<string, ItemReturns>();

  constructor(config: Partial<ReturnTrackerConfig> = {}, store: ReturnTrackerStore = NOOP_STORE) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = store;
    this.hydrate();
  }

  /** Load persisted return state (validated upstream by the store). */
  private hydrate(): void {
    const snapshots = this.store.load();
    if (!snapshots) return;
    for (const snap of snapshots) {
      this.items.set(snap.id, {
        lastVisitAt: snap.lastVisitAt,
        returnCount: snap.returnCount,
        returnTimes: [...snap.returnTimes],
        forfeited: snap.forfeited ?? 0,
      });
    }
  }

  /** Record a visit. A visit ≥ threshold after the previous one is a return. */
  visit(itemId: string, now: number): void {
    const state = this.items.get(itemId) ?? {
      lastVisitAt: Number.NEGATIVE_INFINITY,
      returnCount: 0,
      returnTimes: [],
      forfeited: 0,
    };
    if (
      state.lastVisitAt !== Number.NEGATIVE_INFINITY &&
      now - state.lastVisitAt >= this.config.returnThresholdMs
    ) {
      state.returnCount += 1;
      state.returnTimes.push(now);
    }
    state.returnTimes = state.returnTimes.filter((t) => now - t < this.config.rageWindowMs);
    // Rage loop within the window ⇒ PERMANENTLY forfeit every return counted so
    // far for this item. Forfeited never decreases, so once a burst is detected
    // those returns can never resurrect into the genuine count, even after the
    // window ages out and `returnTimes` shrinks (§6.7 anti-gaming).
    if (state.returnTimes.length >= this.config.rageCount) {
      state.forfeited = state.returnCount;
    }
    state.lastVisitAt = now;
    this.items.set(itemId, state);
    this.persist(now);
  }

  /** True when returns within the window currently exceed the rage threshold. */
  isRageLoop(itemId: string): boolean {
    return (this.items.get(itemId)?.returnTimes.length ?? 0) >= this.config.rageCount;
  }

  /**
   * Genuine return count for the aggregate: the cumulative count minus the
   * returns permanently forfeited to rage-loop dampening. Zero during a burst
   * (all-so-far forfeited) and never credits a past burst's returns (§6.7).
   */
  returnCount(itemId: string): number {
    const state = this.items.get(itemId);
    if (!state) return 0;
    return Math.max(0, state.returnCount - state.forfeited);
  }

  /** Clear all return state, including the local persistence. */
  resetSession(): void {
    this.items.clear();
    this.store.save([]);
  }

  /** Prune stale/over-cap items (bounding local storage) and persist. */
  private persist(now: number): void {
    // Drop items untouched beyond the retention window.
    for (const [id, state] of this.items) {
      if (now - state.lastVisitAt >= this.config.retentionMs) this.items.delete(id);
    }
    // LRU cap: keep only the most-recently-visited maxItems.
    if (this.items.size > this.config.maxItems) {
      const keep = [...this.items.entries()]
        .sort((a, b) => b[1].lastVisitAt - a[1].lastVisitAt)
        .slice(0, this.config.maxItems);
      this.items.clear();
      for (const [id, state] of keep) this.items.set(id, state);
    }
    const snapshots: ReturnSnapshot[] = [...this.items.entries()].map(([id, state]) => ({
      id,
      lastVisitAt: state.lastVisitAt,
      returnCount: state.returnCount,
      returnTimes: state.returnTimes,
      forfeited: state.forfeited,
    }));
    this.store.save(snapshots);
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
