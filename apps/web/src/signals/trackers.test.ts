// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ReturnTracker, TraversalTracker } from './return-tracker.js';
import { OpenTracker } from './source-tracker.js';

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
