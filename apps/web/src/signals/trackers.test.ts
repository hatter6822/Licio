// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  type ReturnSnapshot,
  ReturnTracker,
  type ReturnTrackerStore,
  TraversalTracker,
} from './return-tracker.js';
import { OpenTracker } from './source-tracker.js';

/** An in-memory return-tracker store (deep-copies so the tracker can't alias it). */
function fakeStore(): { store: ReturnTrackerStore; current: () => ReturnSnapshot[] | null } {
  let data: ReturnSnapshot[] | null = null;
  const copy = (s: ReturnSnapshot[]): ReturnSnapshot[] =>
    s.map((x) => ({ ...x, returnTimes: [...x.returnTimes] }));
  return {
    store: {
      load: () => (data ? copy(data) : null),
      save: (snaps) => {
        data = copy(snaps);
      },
    },
    current: () => data,
  };
}

describe('OpenTracker', () => {
  it('counts an open that persists past the minimum duration', () => {
    const tracker = new OpenTracker({ sourceMinMs: 3_000 });
    tracker.open('o1', 'item-1', 'source', 0);
    tracker.close('o1', 3_500);
    expect(tracker.wasSourceOpened('item-1')).toBe(true);
  });

  it('does not count an open shorter than the minimum', () => {
    const tracker = new OpenTracker({ sourceMinMs: 3_000 });
    tracker.open('o1', 'item-1', 'source', 0);
    tracker.close('o1', 1_000);
    expect(tracker.wasSourceOpened('item-1')).toBe(false);
  });

  it('dedups repeated open/close cycles to a single count', () => {
    const tracker = new OpenTracker({ contextMinMs: 2_000 });
    for (let i = 0; i < 5; i += 1) {
      tracker.open(`o${i}`, 'item-1', 'context', i * 10_000);
      tracker.close(`o${i}`, i * 10_000 + 2_500);
    }
    expect(tracker.wasContextOpened('item-1')).toBe(true);
    // Boolean dedup: still just "opened", never a churned count.
    expect(tracker.wasSourceOpened('item-1')).toBe(false);
  });

  it('ignores a close for an unknown open id', () => {
    const tracker = new OpenTracker();
    tracker.close('nope', 5_000);
    expect(tracker.wasSourceOpened('item-1')).toBe(false);
  });

  it('clears opens between sessions', () => {
    const tracker = new OpenTracker({ sourceMinMs: 1_000 });
    tracker.open('o1', 'item-1', 'source', 0);
    tracker.close('o1', 2_000);
    tracker.resetSession();
    expect(tracker.wasSourceOpened('item-1')).toBe(false);
  });
});

describe('ReturnTracker', () => {
  const MIN = 30 * 60_000;

  it('counts a revisit after the time-away threshold', () => {
    const tracker = new ReturnTracker();
    tracker.visit('item-1', 0);
    tracker.visit('item-1', MIN + 1);
    expect(tracker.returnCount('item-1')).toBe(1);
  });

  it('does not count a revisit before the threshold', () => {
    const tracker = new ReturnTracker();
    tracker.visit('item-1', 0);
    tracker.visit('item-1', 60_000);
    expect(tracker.returnCount('item-1')).toBe(0);
  });

  it('dampens a rage loop to zero returns', () => {
    const tracker = new ReturnTracker({ rageWindowMs: 90 * 60_000, rageCount: 3 });
    // Three returns spaced at the minimum threshold, all inside the rage window.
    tracker.visit('item-1', 0);
    tracker.visit('item-1', MIN);
    tracker.visit('item-1', 2 * MIN);
    tracker.visit('item-1', 3 * MIN);
    expect(tracker.isRageLoop('item-1')).toBe(true);
    expect(tracker.returnCount('item-1')).toBe(0);
  });

  it('counts a single genuine return from a notification', () => {
    const tracker = new ReturnTracker();
    tracker.visit('item-1', 0);
    tracker.visit('item-1', 45 * 60_000); // 45 min later
    expect(tracker.isRageLoop('item-1')).toBe(false);
    expect(tracker.returnCount('item-1')).toBe(1);
  });

  it('PERMANENTLY forfeits rage-loop returns — they never resurrect after the window ages out', () => {
    const tracker = new ReturnTracker({ rageWindowMs: 90 * 60_000, rageCount: 3 });
    tracker.visit('item-1', 0);
    tracker.visit('item-1', MIN); // return 1
    tracker.visit('item-1', 2 * MIN); // return 2
    tracker.visit('item-1', 3 * MIN); // return 3 → rage; all forfeited
    expect(tracker.returnCount('item-1')).toBe(0);

    // A genuine return long after the burst (window aged out, no longer a rage loop).
    tracker.visit('item-1', 3 * MIN + 10 * 60 * 60_000); // +10h
    expect(tracker.isRageLoop('item-1')).toBe(false);
    // Only the single post-burst genuine return counts; the 3 hostile returns stay
    // forfeited forever (regression guard for the resurrection bug).
    expect(tracker.returnCount('item-1')).toBe(1);
  });

  it('detects a genuine return across sessions via persistence', () => {
    const backing = fakeStore();
    new ReturnTracker({}, backing.store).visit('item-1', 0); // session 1, persisted
    const next = new ReturnTracker({}, backing.store); // session 2 hydrates state
    next.visit('item-1', MIN + 1); // ≥ threshold after the persisted visit
    expect(next.returnCount('item-1')).toBe(1);
  });

  it('detects a rage loop spanning a reload via persistence', () => {
    const backing = fakeStore();
    const before = new ReturnTracker({}, backing.store);
    before.visit('x', 0);
    before.visit('x', MIN); // return 1
    const after = new ReturnTracker({}, backing.store); // reload
    after.visit('x', 2 * MIN); // return 2
    after.visit('x', 3 * MIN); // return 3 → rage threshold
    expect(after.isRageLoop('x')).toBe(true);
    expect(after.returnCount('x')).toBe(0);
  });

  it('clears persisted state on reset', () => {
    const backing = fakeStore();
    const tracker = new ReturnTracker({}, backing.store);
    tracker.visit('x', 0);
    expect(backing.current()).not.toBeNull();
    tracker.resetSession();
    expect(backing.current()).toEqual([]);
  });

  it('prunes items untouched beyond the retention window', () => {
    const backing = fakeStore();
    const tracker = new ReturnTracker({ retentionMs: 1_000 }, backing.store);
    tracker.visit('old', 0);
    tracker.visit('fresh', 5_000); // 'old' is now 5s stale > 1s retention
    expect((backing.current() ?? []).map((s) => s.id)).toEqual(['fresh']);
  });

  it('evicts least-recently-visited items beyond the cap', () => {
    const backing = fakeStore();
    const tracker = new ReturnTracker({ maxItems: 2 }, backing.store);
    tracker.visit('a', 0);
    tracker.visit('b', 1);
    tracker.visit('c', 2); // exceeds cap → evict the oldest ('a')
    expect((backing.current() ?? []).map((s) => s.id).sort((p, q) => p.localeCompare(q))).toEqual([
      'b',
      'c',
    ]);
  });
});

describe('TraversalTracker', () => {
  it('counts distinct branches and ignores repeats', () => {
    const tracker = new TraversalTracker();
    tracker.visitBranch('t1', 'overview');
    tracker.visitBranch('t1', 'evidence');
    tracker.visitBranch('t1', 'evidence'); // repeat — no increase
    tracker.visitBranch('t1', 'challenges');
    expect(tracker.distinctBranches('t1')).toBe(3);
  });

  it('tracks threads independently and resets between sessions', () => {
    const tracker = new TraversalTracker();
    tracker.visitBranch('t1', 'overview');
    tracker.visitBranch('t2', 'overview');
    expect(tracker.distinctBranches('t1')).toBe(1);
    tracker.resetSession();
    expect(tracker.distinctBranches('t1')).toBe(0);
  });
});
