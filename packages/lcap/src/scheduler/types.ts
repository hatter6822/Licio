// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scheduler value types (OFFLINE_SPEC §15).  A `ScheduledCandidate` is one
// object the scheduler may place, with its lane/priority, byte size, the
// closure `requires` edges that gate its eligibility, and the optional scoring
// inputs (all of which are clamped before use so no single factor can
// un-schedule or NaN an object).

import type { LcapLane, LcapPriority } from '../priority.js';

export interface ScheduledCandidate {
  readonly cid: string;
  readonly lane: LcapLane;
  readonly priority: LcapPriority;
  readonly bytes: number;
  /** CIDs that MUST be placed before this candidate (the trust/render closure). */
  readonly requires: readonly string[];
  /** Why the candidate is in the set (want / interest / outbox / closure). */
  readonly reason: string;
  /** Distinct recent receipts for this object (scarcity boost; §15.5). */
  readonly replicaCount?: number;
  /** User-pinned content (overrides lane weights after C0; §15.6). */
  readonly pinned?: boolean;
  /** A delivery deadline in epoch ms (deadline boost; §15.4). */
  readonly deadlineMs?: number;
  /** Freshness weight input (§15.4). */
  readonly freshness?: number;
  /** Whether the object was explicitly wanted (§15.4). */
  readonly explicitWant?: boolean;
  /** Estimated relative CPU to verify/render (a score divisor; §15.4). */
  readonly estimatedCpu?: number;
  /** Privacy risk of transferring this object (a score divisor; §15.4). */
  readonly privacyRisk?: number;
}

export type LaneByteMap = Record<LcapLane, number>;
