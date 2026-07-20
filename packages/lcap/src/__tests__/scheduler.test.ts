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

  it('keeps the B4 bulk lane structurally dead unless the §15.3 bulk path is active', () => {
    // Default (no bulk opt-in): B4 weight and cap are 0 at every rung.
    expect(computeLaneBudget(600 * 1024).weights.B4).toBe(0);
    expect(computeLaneBudget(600 * 1024).caps.B4).toBe(0);
    expect(computeLaneBudget(600 * 1024, true).caps.B4).toBe(0);
    // With bulk allowed: B4 draws only leftover bytes above the 512 KiB rung,
    // and its weight sits below E2/M3 so it is served last.
    const bulk = computeLaneBudget(600 * 1024, false, true);
    expect(bulk.weights.B4).toBe(5);
    expect(bulk.weights.B4).toBeLessThan(bulk.weights.E2);
    expect(bulk.caps.B4).toBe(Math.floor(0.05 * 600 * 1024));
    // Below the 512 KiB rung, B4 stays 0 even when bulk is allowed.
    expect(computeLaneBudget(100 * 1024, false, true).caps.B4).toBe(0);
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

  it('ships a B4 bulk candidate only when bulkAllowed is threaded through scheduleTransfer', () => {
    const bulk = cand({ cid: 'prefetch', lane: 'B4', priority: 4, bytes: 5_000 });
    const opts = { budgetBytes: 600 * 1024, nowMs: 0 };
    // Default (no bulkAllowed) ⇒ the B4 lane budget is zero, so nothing pre-fetches.
    const off = scheduleTransfer([bulk], opts);
    expect(off.usedByLane.B4).toBe(0);
    expect(off.order.some((c) => c.lane === 'B4')).toBe(false);
    // bulkAllowed threaded through ⇒ B4 gets a reservation and the candidate ships
    // (regression: the option was unreachable from scheduleTransfer, capping B4 at 0).
    const on = scheduleTransfer([bulk], { ...opts, bulkAllowed: true });
    expect(on.usedByLane.B4).toBeGreaterThan(0);
    expect(on.order.some((c) => c.lane === 'B4')).toBe(true);
  });

  it('defers B4 bulk behind a schedulable higher-lane (T1) candidate', () => {
    // Bulk is leftover-only: even with bulkAllowed, a B4 object must not be emitted
    // while a T1 head is still schedulable — otherwise it could consume budget the
    // higher-priority candidate needs.
    const t1 = cand({ cid: 't1', lane: 'T1', priority: 1, bytes: 50_000 });
    const bulk = cand({ cid: 'b4', lane: 'B4', priority: 4, bytes: 1_000 });
    const result = scheduleTransfer([bulk, t1], {
      budgetBytes: 600 * 1024,
      nowMs: 0,
      bulkAllowed: true,
    });
    const t1Index = result.order.findIndex((c) => c.cid === 't1');
    const b4Index = result.order.findIndex((c) => c.cid === 'b4');
    expect(t1Index).toBeGreaterThanOrEqual(0);
    expect(b4Index).toBeGreaterThan(t1Index); // B4 only after T1 is satisfied
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

  it('releases the media gate when a C0 object depends on a never-placeable prerequisite', () => {
    // A C0 control object depends on a prerequisite that can NEVER be placed in this run
    // (here: a C0 dep far larger than the whole budget).  Membership-only "pending" logic
    // treated the dep as in-progress and held the media gate forever (total M3/B4
    // starvation + a maxRounds busy-spin).  `everPlaceable` recognises the dep can never
    // fit, so the impossible C0 closure no longer holds the gate and media ships.
    const impossibleDep = cand({ cid: 'huge', lane: 'C0', priority: 0, bytes: 100_000_000 });
    const c0blocked = cand({
      cid: 'c0blocked',
      lane: 'C0',
      priority: 0,
      bytes: 100,
      requires: ['huge'],
    });
    const media = Array.from({ length: 5 }, (_, i) =>
      cand({ cid: `m${i}`, lane: 'M3', priority: 3, bytes: 10_000 }),
    );
    const result = scheduleTransfer([...media, c0blocked, impossibleDep], {
      budgetBytes: 600 * 1024,
      mediaRequested: true,
      nowMs: 0,
    });
    // Neither the impossible dep nor the object gated on it can be placed.
    expect(result.order.some((c) => c.cid === 'huge')).toBe(false);
    expect(result.order.some((c) => c.cid === 'c0blocked')).toBe(false);
    // But media is NOT starved — the unsatisfiable C0 closure released the gate.
    expect(result.order.some((c) => c.lane === 'M3')).toBe(true);
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
