// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_DWELL_CAP_MS, DwellCapTracker } from './caps.js';
import { DwellAccumulator } from './dwell.js';

/** A controllable monotonic clock. */
function fakeClock(start = 0) {
  let t = start;
  const now = () => t;
  return { now, advance: (ms: number) => (t += ms) };
}

describe('DwellAccumulator', () => {
  it('accrues time only while engaged', () => {
    const clock = fakeClock();
    const dwell = new DwellAccumulator(clock.now);
    clock.advance(1_000); // not engaged yet
    expect(dwell.ms).toBe(0);
    dwell.setEngaged(true);
    clock.advance(2_000);
    expect(dwell.ms).toBe(2_000);
    dwell.setEngaged(false);
    clock.advance(5_000); // paused
    expect(dwell.ms).toBe(2_000);
    dwell.setEngaged(true);
    clock.advance(1_000);
    expect(dwell.ms).toBe(3_000);
  });

  it('contributes nothing for a backward clock step', () => {
    let t = 1_000;
    const dwell = new DwellAccumulator(() => t);
    dwell.setEngaged(true);
    t = 500; // clock went backwards
    expect(dwell.ms).toBe(0);
  });

  it('resets to zero', () => {
    const clock = fakeClock();
    const dwell = new DwellAccumulator(clock.now);
    dwell.setEngaged(true);
    clock.advance(1_000);
    dwell.reset();
    expect(dwell.ms).toBe(0);
    expect(dwell.isEngaged).toBe(false);
  });
});

describe('DwellCapTracker', () => {
  it('caps counted dwell at the cap and reports the counted delta', () => {
    const cap = new DwellCapTracker(1_000);
    expect(cap.add('a', 600)).toBe(600);
    expect(cap.add('a', 600)).toBe(400); // only 400 left before the cap
    expect(cap.add('a', 600)).toBe(0); // already capped
    expect(cap.get('a')).toBe(1_000);
    expect(cap.isCapped('a')).toBe(true);
  });

  it('tracks caps independently per item', () => {
    const cap = new DwellCapTracker(1_000);
    cap.add('a', 1_000);
    cap.add('b', 200);
    expect(cap.isCapped('a')).toBe(true);
    expect(cap.isCapped('b')).toBe(false);
  });

  it('resets the allowance between sessions', () => {
    const cap = new DwellCapTracker(1_000);
    cap.add('a', 1_000);
    cap.resetSession();
    expect(cap.get('a')).toBe(0);
    expect(cap.isCapped('a')).toBe(false);
  });

  it('ignores negative deltas', () => {
    const cap = new DwellCapTracker();
    expect(cap.add('a', -500)).toBe(0);
    expect(cap.get('a')).toBe(0);
  });

  it('defaults the cap to the long/extended boundary', () => {
    expect(DEFAULT_DWELL_CAP_MS).toBe(300_000);
  });
});
