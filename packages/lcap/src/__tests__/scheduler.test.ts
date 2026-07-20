// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.5 — the lane scheduler: byte reservations + the small-session ladder,
// closure-complete candidate assembly, the clamped finite score, and the two
// structural invariants (C0 cannot be starved by media; a dependent is never
// placed before its dependency).

import { describe, expect, it } from 'vitest';
import type { LcapLane, LcapPriority } from '../priority.js';
import {
  assembleCandidates,
  assertC0Purity,
  C0_MIN_BYTES,
  clampDivisor,
  clampWeight,
  computeLaneBudget,
  isClosureComplete,
  orderLane,
  type ScheduledCandidate,
  scarcityWeight,
  scheduleTransfer,
  scoreCandidate,
} from '../scheduler/index.js';

function cand(
  over: Partial<ScheduledCandidate> & {
    cid: string;
    lane: LcapLane;
    priority: LcapPriority;
    bytes: number;
  },
): ScheduledCandidate {
  return { requires: [], reason: 'test', ...over };
}

function obj(
  cid: string,
  lane: LcapLane,
  priority: LcapPriority,
  bytes: number,
): Omit<ScheduledCandidate, 'requires'> {
  return { cid, lane, priority, bytes, reason: 'test' };
}

describe('reservations + ladder (WS-R.5.1)', () => {
  it('zeroes higher lanes for small sessions and opens them as the budget grows', () => {
    expect(computeLaneBudget(4 * 1024).caps).toMatchObject({ T1: 0, E2: 0, M3: 0 });
    expect(computeLaneBudget(4 * 1024).c0MinBytes).toBe(4 * 1024); // ≤ the 8 KiB minimum
    expect(computeLaneBudget(100 * 1024).caps.T1).toBeGreaterThan(0);
    expect(computeLaneBudget(100 * 1024).caps.E2).toBe(0);
    expect(computeLaneBudget(400 * 1024).caps.E2).toBeGreaterThan(0);
    expect(computeLaneBudget(600 * 1024, true).caps.M3).toBeGreaterThan(0);
    expect(computeLaneBudget(600 * 1024, false).caps.M3).toBe(0);
    expect(computeLaneBudget(100 * 1024).c0MinBytes).toBe(C0_MIN_BYTES);
  });

  it('forbids non-P0 material in C0', () => {
    expect(() => assertC0Purity('C0', 1)).toThrow();
    expect(() => assertC0Purity('C0', 0)).not.toThrow();
    expect(() => assertC0Purity('T1', 1)).not.toThrow();
  });
});

describe('candidate assembly (WS-R.5.2a)', () => {
  const objects = new Map([
    ['post', obj('post', 'T1', 1, 100)],
    ['cert', obj('cert', 'C0', 0, 50)],
    ['cap', obj('cap', 'C0', 0, 50)],
    ['proof', obj('proof', 'C0', 0, 64)],
    ['private', obj('private', 'T1', 1, 200)],
  ]);
  const requiresOf = (cid: string) => (cid === 'post' ? ['cert', 'cap', 'proof'] : []);

  it('promotes the full closure and stays closure-complete', () => {
    const result = assembleCandidates({
      objects,
      seeds: ['post'],
      forbidden: () => false,
      requiresOf,
    });
    expect(result.map((c) => c.cid).sort()).toEqual(['cap', 'cert', 'post', 'proof']);
    expect(isClosureComplete(result)).toBe(true);
  });

  it('removes a forbidden seed before promoting closures, deterministically', () => {
    const forbidden = (cid: string) => cid === 'private';
    const a = assembleCandidates({ objects, seeds: ['post', 'private'], forbidden, requiresOf });
    const b = assembleCandidates({ objects, seeds: ['private', 'post'], forbidden, requiresOf });
    expect(a.map((c) => c.cid)).not.toContain('private');
    expect(a.map((c) => c.cid)).toEqual(b.map((c) => c.cid)); // deterministic
  });
});

describe('scoring (WS-R.5.2c, 5.3)', () => {
  it('is always finite and positive, even with zero/∞ inputs', () => {
    const pathological = cand({
      cid: 'x',
      lane: 'T1',
      priority: 1,
      bytes: 0,
      freshness: 0,
      estimatedCpu: Number.POSITIVE_INFINITY,
      replicaCount: -5,
    });
    const score = scoreCandidate(pathological, { nowMs: 0 });
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
    expect(clampWeight(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampWeight(0)).toBe(0.01);
    expect(clampDivisor(0)).toBe(1);
  });

  it('boosts scarcer objects and orders shortest-first with a pin override', () => {
    expect(scarcityWeight(0)).toBeGreaterThan(scarcityWeight(5));
    const big = cand({ cid: 'a', lane: 'T1', priority: 1, bytes: 1000 });
    const small = cand({ cid: 'b', lane: 'T1', priority: 1, bytes: 100 });
    const pinned = cand({ cid: 'p', lane: 'T1', priority: 1, bytes: 5000, pinned: true });
    expect(orderLane([big, small, pinned], { nowMs: 0 }).map((c) => c.cid)).toEqual([
      'p',
      'b',
      'a',
    ]);
  });
});

describe('allocation invariants (WS-R.5.2b, 5.4)', () => {
  it('reserves C0 before any media under an all-media flood', () => {
    const media = Array.from({ length: 10 }, (_, i) =>
      cand({ cid: `m${i}`, lane: 'M3', priority: 3, bytes: 10_000 }),
    );
    const control = cand({ cid: 'revocation', lane: 'C0', priority: 0, bytes: 200 });
    const result = scheduleTransfer([...media, control], {
      budgetBytes: 600 * 1024,
      mediaRequested: true,
      nowMs: 0,
    });
    const c0Index = result.order.findIndex((c) => c.lane === 'C0');
    const firstMediaIndex = result.order.findIndex((c) => c.lane === 'M3');
    expect(c0Index).toBe(0);
    expect(firstMediaIndex).toBeGreaterThan(0); // media DOES ship, but after C0
  });

  it('never places a dependent before its dependency', () => {
    const dependency = cand({ cid: 'cap', lane: 'C0', priority: 0, bytes: 50 });
    const dependent = cand({ cid: 'post', lane: 'T1', priority: 1, bytes: 100, requires: ['cap'] });
    const result = scheduleTransfer([dependent, dependency], { budgetBytes: 10_000, nowMs: 0 });
    expect(result.order.findIndex((c) => c.cid === 'cap')).toBeLessThan(
      result.order.findIndex((c) => c.cid === 'post'),
    );
  });

  it('keeps media gated while a C0 object is blocked on a not-yet-placed prerequisite', () => {
    // A C0 control object depends on a T1 object: until the WHOLE C0 closure (the T1 dep
    // then the C0 object) is placed, no media may ship (§15.2 anti-starvation).
    const t1dep = cand({ cid: 't1dep', lane: 'T1', priority: 1, bytes: 100 });
    const c0blocked = cand({
      cid: 'c0blocked',
      lane: 'C0',
      priority: 0,
      bytes: 100,
      requires: ['t1dep'],
    });
    const media = Array.from({ length: 5 }, (_, i) =>
      cand({ cid: `m${i}`, lane: 'M3', priority: 3, bytes: 10_000 }),
    );
    const result = scheduleTransfer([...media, c0blocked, t1dep], {
      budgetBytes: 600 * 1024,
      mediaRequested: true,
      nowMs: 0,
    });
    const c0Index = result.order.findIndex((c) => c.cid === 'c0blocked');
    const firstMediaIndex = result.order.findIndex((c) => c.lane === 'M3');
    expect(c0Index).toBeGreaterThanOrEqual(0); // the C0 object is placed (after its dep)
    expect(firstMediaIndex).toBeGreaterThan(c0Index); // media only AFTER the C0 closure lands
  });

  it('does not starve a pinned head behind smaller unpinned objects under contention (§15.6)', () => {
    // A large pinned T1 object + many small unpinned T1 objects, with a budget that
    // cannot fit them all.  The deficit skip-over bug placed the smalls (draining the
    // lane budget) and never shipped the pinned head; the head-of-line DRR fix places
    // the pinned object FIRST (orderLane ranks pinned ahead of smaller ones).
    const pinned = cand({ cid: 'pin', lane: 'T1', priority: 1, bytes: 8_000, pinned: true });
    const smalls = Array.from({ length: 40 }, (_, i) =>
      cand({ cid: `s${i}`, lane: 'T1', priority: 1, bytes: 2_000 }),
    );
    const result = scheduleTransfer([...smalls, pinned], { budgetBytes: 200 * 1024, nowMs: 0 });
    const pinIndex = result.order.findIndex((c) => c.cid === 'pin');
    expect(pinIndex).toBeGreaterThanOrEqual(0); // placed, not starved
    const firstSmallIndex = result.order.findIndex((c) => c.cid.startsWith('s'));
    expect(pinIndex).toBeLessThan(firstSmallIndex); // and shipped ahead of the smalls
  });

  it('stops before budget overflow and is deterministic', () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      cand({ cid: `t${i}`, lane: 'T1', priority: 1, bytes: 3000 }),
    );
    const opts = { budgetBytes: 7000, nowMs: 0 };
    const r1 = scheduleTransfer(candidates, opts);
    const r2 = scheduleTransfer(candidates, opts);
    expect(r1.usedBytes).toBeLessThanOrEqual(7000);
    expect(r1.packTable.map((e) => e.cid)).toEqual(r2.packTable.map((e) => e.cid));
    expect(r1.packTable.every((e, i) => e.transferIndex === i)).toBe(true);
  });
});
