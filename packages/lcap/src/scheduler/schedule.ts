// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The full lane scheduler (OFFLINE_SPEC §15.4, WS-R.5.2c).  Composes 5.2a→b→c:
// group candidates by lane, order each lane (shortest-verifiable-first + deadline
// boost + pin, ties by score), reserve C0 + run DRR, and emit the transfer-order
// pack table for the writer (WS-R.4.1).  Deterministic for a fixed input.

import { LANE_ORDER, type LcapLane, type LcapPriority } from '../priority.js';
import { allocate } from './allocate.js';
import { computeLaneBudget } from './reservations.js';
import { orderLane, type ScoreContext } from './score.js';
import type { ScheduledCandidate } from './types.js';

export interface ScheduleOptions {
  readonly budgetBytes: number;
  readonly mediaRequested?: boolean;
  readonly nowMs: number;
  readonly deadlineWindowMs?: number;
}

/** One transfer-order entry the pack writer consumes. */
export interface PackTableEntry {
  readonly cid: string;
  readonly lane: LcapLane;
  readonly priority: LcapPriority;
  readonly bytes: number;
  readonly transferIndex: number;
}

export interface ScheduleResult {
  readonly order: readonly ScheduledCandidate[];
  readonly packTable: readonly PackTableEntry[];
  readonly usedByLane: Record<LcapLane, number>;
  readonly usedBytes: number;
}

/** Schedule candidates into transfer order under a byte budget. */
export function scheduleTransfer(
  candidates: readonly ScheduledCandidate[],
  options: ScheduleOptions,
): ScheduleResult {
  const laneBudget = computeLaneBudget(options.budgetBytes, options.mediaRequested ?? false);
  const ctx: ScoreContext = {
    nowMs: options.nowMs,
    ...(options.deadlineWindowMs !== undefined
      ? { deadlineWindowMs: options.deadlineWindowMs }
      : {}),
  };

  const byLane: Record<LcapLane, ScheduledCandidate[]> = { C0: [], T1: [], E2: [], M3: [], B4: [] };
  for (const candidate of candidates) byLane[candidate.lane].push(candidate);

  const ordered: Record<LcapLane, ScheduledCandidate[]> = {
    C0: [],
    T1: [],
    E2: [],
    M3: [],
    B4: [],
  };
  for (const lane of LANE_ORDER) ordered[lane] = orderLane(byLane[lane], ctx);

  const result = allocate(ordered, laneBudget, options.budgetBytes);
  const packTable: PackTableEntry[] = result.order.map((candidate, transferIndex) => ({
    cid: candidate.cid,
    lane: candidate.lane,
    priority: candidate.priority,
    bytes: candidate.bytes,
    transferIndex,
  }));

  return {
    order: result.order,
    packTable,
    usedByLane: result.usedByLane,
    usedBytes: result.usedBytes,
  };
}
