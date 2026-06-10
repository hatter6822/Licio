// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Distributed job lease (WS-D.2.2c/2.4a "scheduler" binding).  N API instances
// each tick the privacy scheduler; the lease guarantees AT MOST ONE instance
// executes a given job per window.  Safety does not depend on the lease: both
// privacy jobs are idempotent and retention is also enforced at read time, so
// a crashed holder simply means the work happens when the lease expires and the
// next tick claims it.  The lease only prevents duplicate concurrent work.
//
// The claim must be ATOMIC (insert-or-steal-expired in one statement) — see
// DrizzleJobLeaseStore in drizzle-store.ts for the production Postgres binding.

export interface JobLeaseStore {
  /**
   * Try to claim `jobName` until `now + ttlMs`.  True ⇒ the caller owns the
   * job for this window and must run it; false ⇒ another holder's lease is
   * still live.  An expired lease is stolen atomically.
   */
  tryAcquire(jobName: string, ttlMs: number, holder: string, now?: number): Promise<boolean>;
}

/** Single-process adapter (tests / local dev): a Map of live leases. */
export class InMemoryJobLeaseStore implements JobLeaseStore {
  readonly #leases = new Map<string, { lockedUntil: number; holder: string }>();

  async tryAcquire(
    jobName: string,
    ttlMs: number,
    holder: string,
    now: number = Date.now(),
  ): Promise<boolean> {
    const existing = this.#leases.get(jobName);
    if (existing && existing.lockedUntil > now) return false;
    this.#leases.set(jobName, { lockedUntil: now + ttlMs, holder });
    return true;
  }

  clear(): void {
    this.#leases.clear();
  }
}

/** A lease that always grants — single-process semantics (the dev default). */
export class AlwaysGrantJobLeaseStore implements JobLeaseStore {
  async tryAcquire(): Promise<boolean> {
    return true;
  }
}
