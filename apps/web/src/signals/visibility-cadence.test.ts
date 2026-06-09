// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { CadenceTracker } from './cadence.js';
import { EngagementTracker } from './visibility.js';

describe('EngagementTracker', () => {
  it('is active only when both visible and focused', () => {
    let visible = true;
    let focused = true;
    const tracker = new EngagementTracker({ isVisible: () => visible, isFocused: () => focused });
    expect(tracker.isActive).toBe(true);

    focused = false;
    tracker.refresh();
    expect(tracker.isActive).toBe(false);

    focused = true;
    visible = false;
    tracker.refresh();
    expect(tracker.isActive).toBe(false);

    visible = true;
    tracker.refresh();
    expect(tracker.isActive).toBe(true);
  });

  it('notifies subscribers only on a change', () => {
    let visible = true;
    const tracker = new EngagementTracker({ isVisible: () => visible, isFocused: () => true });
    const listener = vi.fn();
    tracker.subscribe(listener);
    tracker.refresh(); // no change
    expect(listener).not.toHaveBeenCalled();
    visible = false;
    tracker.refresh();
    expect(listener).toHaveBeenCalledWith(false);
  });

  it('derives the AND from current state even without paired events', () => {
    let visible = true;
    let focused = true;
    const tracker = new EngagementTracker({ isVisible: () => visible, isFocused: () => focused });
    // A visibilitychange fires but focus already silently dropped: still inactive.
    visible = false;
    focused = false;
    tracker.refresh();
    expect(tracker.isActive).toBe(false);
  });
});

describe('CadenceTracker', () => {
  it('classifies steady scrolling as reading and fast scrolling as skimming', () => {
    const tracker = new CadenceTracker({ skimVelocityPxPerMs: 2, sampleMs: 100 });
    tracker.sample(0, 0); // first sample initialises
    tracker.sample(100, 200); // 100px / 200ms = 0.5 px/ms → reading
    expect(tracker.cadence).toBe('reading');
    tracker.sample(2_000, 400); // 1900px / 200ms = 9.5 px/ms → skimming
    expect(tracker.cadence).toBe('skimming');
  });

  it('does not classify a programmatic scroll as skimming', () => {
    const tracker = new CadenceTracker();
    tracker.sample(0, 0);
    tracker.markProgrammaticScroll();
    tracker.sample(5_000, 50); // huge jump, but suppressed
    expect(tracker.cadence).not.toBe('skimming');
  });

  it('throttles samples closer than the sample window', () => {
    const tracker = new CadenceTracker({ sampleMs: 100, skimVelocityPxPerMs: 2 });
    tracker.sample(0, 0); // first sample → reading
    tracker.sample(10_000, 50); // a huge jump within the throttle window → ignored
    expect(tracker.cadence).toBe('reading'); // not reclassified as skimming
  });

  it('transitions to idle after the idle threshold', () => {
    const tracker = new CadenceTracker({ idleMs: 30_000, sampleMs: 100 });
    tracker.sample(0, 0);
    tracker.sample(100, 200);
    expect(tracker.cadence).toBe('reading');
    tracker.checkIdle(35_000);
    expect(tracker.cadence).toBe('idle');
  });
});
