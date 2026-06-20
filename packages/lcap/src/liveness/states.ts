// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-record liveness model (OFFLINE_SPEC §20.1-§20.3, WS-R.10.1).  Liveness
// states are LOCAL observations of delivery health, never assumed global
// delivery: a state advances only on locally-observed evidence (a receipt, a
// checkpoint).  Transitions are monotonic forward — the current state is the
// highest rank ever reached.  The §20.3 replication targets are represented per
// priority class so the replication-health UI can show progress toward them.

import type { LcapPriorityClass } from '../priority.js';

export type LivenessState =
  | 'local_created'
  | 'local_signed'
  | 'queued'
  | 'packed'
  | 'exported'
  | 'peer_stored'
  | 'relay_stored'
  | 'server_stored'
  | 'server_accepted'
  | 'checkpointed'
  | 'witnessed';

const RANK: Readonly<Record<LivenessState, number>> = {
  local_created: 0,
  local_signed: 1,
  queued: 2,
  packed: 3,
  exported: 4,
  peer_stored: 5,
  relay_stored: 6,
  server_stored: 7,
  server_accepted: 8,
  checkpointed: 9,
  witnessed: 10,
};

/**
 * Tracks a record's liveness: the first-reached timestamp of every observed
 * state, with the current state being the highest rank reached.  Observing a
 * state is idempotent (keeps the earliest timestamp) and never moves backward.
 */
export class LivenessTracker {
  private readonly reachedAt = new Map<LivenessState, number>();

  constructor(createdAtMs: number) {
    this.reachedAt.set('local_created', createdAtMs);
  }

  /** Record that `state` was observed at `atMs` (keeps the earliest sighting). */
  observe(state: LivenessState, atMs: number): void {
    if (!this.reachedAt.has(state)) this.reachedAt.set(state, atMs);
  }

  /** The highest-rank state reached so far. */
  get current(): LivenessState {
    let best: LivenessState = 'local_created';
    for (const state of this.reachedAt.keys()) {
      if (RANK[state] > RANK[best]) best = state;
    }
    return best;
  }

  firstReachedAt(state: LivenessState): number | undefined {
    return this.reachedAt.get(state);
  }

  has(state: LivenessState): boolean {
    return RANK[this.current] >= RANK[state];
  }
}

/** The §20.3 replication target (minimum distinct replicas) per priority class. */
export const LIVENESS_TARGET: Readonly<Record<LcapPriorityClass, number>> = {
  P0: 8, // C0 control: never below 8 known replicas where possible
  P1: 3, // T1 text: 3-5 distinct storage receipts
  P2: 2, // E2 evidence: 2 distinct replicas
  P3: 1, // M3 media: 1 server/relay copy + explicit demand
  P4: 0, // B4 bulk: no liveness target
};

/** Whether the observed replica count meets the §20.3 target for a class. */
export function livenessTargetMet(priorityClass: LcapPriorityClass, replicaCount: number): boolean {
  return replicaCount >= LIVENESS_TARGET[priorityClass];
}
