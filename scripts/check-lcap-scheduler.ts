// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.5.4 — the lane-scheduler CI gate (OFFLINE_SPEC §15.2, §32.2).  Asserts
// the two structural scheduler invariants over adversarial candidate mixes:
//   1. C0 cannot be starved by M3/B4 — no media/bulk object is placed before a
//      schedulable C0 object.
//   2. A dependent object is never placed before the dependencies needed to
//      verify or render it (every `requires` edge precedes the dependent).
// Includes worst-case fixtures (all-media flood, deep dependency chains,
// dependency-bomb fan-outs within caps) plus seeded random mixes.

import type { LcapLane, LcapPriority, ScheduledCandidate } from '@licio/lcap';
import { scheduleTransfer } from '@licio/lcap';

type Candidate = ScheduledCandidate;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANE_PRIORITY: Record<LcapLane, LcapPriority> = { C0: 0, T1: 1, E2: 2, M3: 3, B4: 4 };

/** No media/bulk object precedes a placed C0 object. */
function c0NotStarved(order: readonly Candidate[]): string | null {
  const firstMedia = order.findIndex((c) => c.lane === 'M3' || c.lane === 'B4');
  if (firstMedia < 0) return null;
  for (let i = firstMedia; i < order.length; i++) {
    if ((order[i] as Candidate).lane === 'C0') {
      return `C0 object ${(order[i] as Candidate).cid} placed after media at index ${firstMedia}`;
    }
  }
  return null;
}

/** Every `requires` edge of a placed candidate precedes it in the order. */
function dependencyOrder(order: readonly Candidate[]): string | null {
  const placed = new Set<string>();
  for (const candidate of order) {
    for (const dep of candidate.requires) {
      if (!placed.has(dep)) {
        return `${candidate.cid} placed before (or without) its dependency ${dep}`;
      }
    }
    placed.add(candidate.cid);
  }
  return null;
}

function check(
  name: string,
  candidates: Candidate[],
  budgetBytes: number,
  mediaRequested: boolean,
): string[] {
  const { order } = scheduleTransfer(candidates, { budgetBytes, mediaRequested, nowMs: 0 });
  const errors: string[] = [];
  const starvation = c0NotStarved(order);
  if (starvation) errors.push(`[${name}] ${starvation}`);
  const ordering = dependencyOrder(order);
  if (ordering) errors.push(`[${name}] ${ordering}`);
  return errors;
}

function cand(cid: string, lane: LcapLane, bytes: number, requires: string[] = []): Candidate {
  return { cid, lane, priority: LANE_PRIORITY[lane], bytes, requires, reason: 'gate' };
}

const errors: string[] = [];

// Fixture 1 — all-media flood with a handful of C0 controls.
{
  const flood: Candidate[] = [];
  for (let i = 0; i < 60; i++) flood.push(cand(`m${i}`, 'M3', 20_000));
  for (let i = 0; i < 5; i++) flood.push(cand(`rev${i}`, 'C0', 500));
  errors.push(...check('all-media-flood', flood, 2 * 1024 * 1024, true));
}

// Fixture 2 — a deep dependency chain across lanes.
{
  const chain: Candidate[] = [cand('root', 'C0', 100)];
  for (let i = 1; i < 20; i++)
    chain.push(cand(`n${i}`, i % 2 ? 'T1' : 'E2', 1000, [i === 1 ? 'root' : `n${i - 1}`]));
  errors.push(...check('deep-chain', chain.reverse(), 1024 * 1024, true));
}

// Fixture 3 — a dependency-bomb fan-out (one C0 cap, many T1 dependents).
{
  const bomb: Candidate[] = [cand('cap', 'C0', 200)];
  for (let i = 0; i < 40; i++) bomb.push(cand(`d${i}`, 'T1', 1500, ['cap']));
  errors.push(...check('dependency-bomb', bomb, 512 * 1024, true));
}

// Fixtures 4..N — seeded random adversarial mixes.
const lanes: LcapLane[] = ['C0', 'T1', 'E2', 'M3', 'B4'];
for (let scenario = 0; scenario < 300; scenario++) {
  const rng = mulberry32(scenario + 1);
  const n = 5 + Math.floor(rng() * 40);
  const candidates: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    const lane = lanes[Math.floor(rng() * lanes.length)] as LcapLane;
    const bytes = 100 + Math.floor(rng() * 20_000);
    // A closure dependency always points to EQUAL-OR-HIGHER-priority material
    // (content depends on its trust closure, never the reverse) and to an earlier
    // candidate (acyclic).  So a C0 object never depends on later media.
    const requires: string[] = [];
    if (i > 0 && rng() < 0.4) {
      const j = Math.floor(rng() * i);
      const dep = candidates[j] as Candidate;
      if (LANE_PRIORITY[dep.lane] <= LANE_PRIORITY[lane]) requires.push(dep.cid);
    }
    candidates.push(cand(`c${i}`, lane, bytes, requires));
  }
  const budget = 16 * 1024 + Math.floor(rng() * (2 * 1024 * 1024));
  errors.push(...check(`random-${scenario}`, candidates, budget, rng() < 0.5));
}

if (errors.length > 0) {
  console.error('LCAP scheduler invariant check FAILED:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  'LCAP scheduler invariants OK: C0 cannot be starved; no dependent precedes its dependency.',
);
