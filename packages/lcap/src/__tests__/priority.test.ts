// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §15.1.1 priority ↔ class ↔ lane SSOT: every wire priority maps to exactly
// one replication class and one default lane, in a fixed scheduling order, and
// only P0 is control-priority (the lane scheduler and replication policy both
// key off this module, so it is pinned directly).

import { describe, expect, it } from 'vitest';
import {
  CONTROL_PRIORITY,
  defaultLane,
  isControlPriority,
  LANE_ORDER,
  type LcapPriority,
  priorityClass,
} from '../priority.js';

const ALL: readonly LcapPriority[] = [0, 1, 2, 3, 4];

describe('priority ↔ class ↔ lane SSOT (§15.1.1)', () => {
  it('maps each priority to its documented replication class', () => {
    expect(ALL.map(priorityClass)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4']);
  });

  it('maps each priority to its documented default lane', () => {
    expect(ALL.map(defaultLane)).toEqual(['C0', 'T1', 'E2', 'M3', 'B4']);
  });

  it('orders lanes C0→B4 (control first, bulk last) — defaultLane(i) is LANE_ORDER[i]', () => {
    expect(LANE_ORDER).toEqual(['C0', 'T1', 'E2', 'M3', 'B4']);
    expect(ALL.map(defaultLane)).toEqual([...LANE_ORDER]);
  });

  it('treats only P0 as control-priority', () => {
    expect(CONTROL_PRIORITY).toBe(0);
    expect(isControlPriority(CONTROL_PRIORITY)).toBe(true);
    for (const p of [1, 2, 3, 4] as const) {
      expect(isControlPriority(p)).toBe(false);
    }
  });
});
