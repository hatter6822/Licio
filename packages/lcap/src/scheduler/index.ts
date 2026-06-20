// SPDX-License-Identifier: AGPL-3.0-or-later
export {
  type AllocationResult,
  allocate,
} from './allocate.js';
export {
  assembleCandidates,
  type CandidateAssemblyInput,
  isClosureComplete,
} from './candidates.js';
export {
  assertC0Purity,
  C0_MIN_BYTES,
  computeLaneBudget,
  type LaneBudget,
} from './reservations.js';
export {
  type PackTableEntry,
  type ScheduleOptions,
  type ScheduleResult,
  scheduleTransfer,
} from './schedule.js';
export {
  clampDivisor,
  clampWeight,
  orderLane,
  type ScoreContext,
  scarcityWeight,
  scoreCandidate,
} from './score.js';
export type { LaneByteMap, ScheduledCandidate } from './types.js';
