// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.3 — ONE UNIT: a moderation state change and the audit record of it.
//
// THE DEFECT.  Assignment is a compare-and-set, so a case cannot be moved by a reviewer
// working from a stale snapshot, and every `assign` row names an edge a write actually
// performed.  But the CAS committed and the audit row was appended AFTER it, in a
// separate transaction — so a reviewer delayed between those two steps could have their
// row land after a later reviewer's:
//
//   B claims        (CAS commits: unassigned → B)
//   C reassigns     (CAS commits: B → C)
//   C's audit row appends            ordinal 8
//   B's audit row appends            ordinal 9   ← B was delayed
//
// Reading the trail by FOLLOWING EDGES still reconstructs it — (unassigned→B), (B→C)
// compose regardless of order.  Reading by RECENCY does not: the last row says B holds a
// case that C holds.  A trail whose order can lie about the present is only half an
// accountability record, and "read it the right way" is a caveat, not a property.
//
// THE FIX is not more ordering logic; it is removing the gap.  With the audit append
// inside the transaction that performs the CAS, a unit that DEPENDS on another's outcome
// cannot begin until that outcome is committed — and the audit row is part of what
// commits.  C's reassignment names B as the expected holder, so it can only succeed once
// B is the visible holder, which is only true after B's whole unit has landed.
//
// Note this is NOT lock-blocking, and the difference matters when reasoning about it: C's
// `UPDATE … WHERE assigned_to = B` does not wait on B's row lock at all, because under
// READ COMMITTED the predicate does not match the row C can see.  C simply matches
// nothing and retries.  The ordering comes from visibility, not from contention — which
// is the stronger property, since it holds however the two requests are scheduled.  (The
// gated test asserts C actually had to retry, so the fixture is proven to have put the
// two in contention rather than running them in sequence.)
//
// WHAT IT COSTS, stated plainly.  An audit failure now rolls the state change back
// instead of degrading to an alert.  That is the intended inversion: not "enforcement
// proceeds, accountability degrades", but "no state change without its record".  The
// failure that actually occurs — a chain parent collision — is absorbed below this seam
// by a savepoint and a retry, so it never surfaces to a unit at all.
//
// PER UNIT, never per batch.  The bulk endpoints loop over cases with per-item results;
// one transaction around the loop would take row locks on many cases in request order,
// and two bulk operations over overlapping sets in different orders would deadlock.  One
// case per unit keeps a single lock order — case row, then the chain — which no cycle
// can form across.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { InMemoryRollback } from '../lib/in-memory-rollback.js';
import type { AuditWriteInput } from './audit.js';
import type { ModerationActionStore, ModerationCaseStore } from './stores.js';

/**
 * The stores a unit may touch, bound to ONE transaction.
 *
 * Deliberately NARROW.  Everything reachable here is a durable write that belongs inside
 * the unit; anything that must not be rolled back — sending a member notice, paging
 * on-call, publishing an event — is absent by construction rather than by convention, so
 * it stays outside where it belongs.
 */
export interface ModerationTx {
  readonly cases: ModerationCaseStore;
  readonly actions: ModerationActionStore;
  /**
   * Append this unit's audit record, chained, inside this transaction.
   *
   * THROWS on failure, and that is the point: the state change has not committed yet, so
   * the failure takes it down too.  Use this rather than `writeAudit` inside a unit —
   * `writeAudit` writes through the services' own handle, which is a different
   * transaction, which is the gap this seam closes.
   */
  audit(input: AuditWriteInput): Promise<string>;
}

/**
 * Run a state change and its audit record as one atomic unit.
 *
 * An interface with a named implementation per side, not a bare function: the runtime
 * parity guard (`lib/parity-guard.ts`) recognises an un-swapped in-memory adapter by its
 * CLASS NAME, and skips anything that is not an object.  A function-valued field would be
 * invisible to it — production could run Postgres stores beside the in-memory unit of
 * work and boot happily.
 */
export interface ModerationTransactor {
  run<T>(work: (tx: ModerationTx) => Promise<T>): Promise<T>;
}

/**
 * The in-memory `ModerationTransactor`: snapshot → run → restore on ANY throw.
 *
 * SERIALISED, which goes beyond what the compliance twin does and is load-bearing here.
 * In production the ordering comes from transaction VISIBILITY — a unit cannot observe
 * another's state change until that unit has fully committed.  A fold over Maps has no
 * such boundary: every write is visible the instant it happens, and there ARE awaits
 * between the CAS and the append, so two interleaved units reproduce exactly the disorder
 * this seam removes and the twin fails to demonstrate the property it exists to mirror.
 * A promise chain is the whole mechanism.
 *
 * Re-entrant runs JOIN the ambient unit rather than taking a second snapshot, matching
 * the single transaction the Drizzle adapter opens.  Without the join a nested run would
 * also wait on a queue slot its own caller is holding — a deadlock, not a slowdown.
 */
export class InMemoryModerationTransactor implements ModerationTransactor {
  readonly #tx: ModerationTx;
  readonly #rollbacks: readonly InMemoryRollback[];
  /**
   * The ambient unit, if this call is running INSIDE one.
   *
   * A depth counter cannot answer this, and the difference is not academic: a counter
   * says "some unit is in flight", which is equally true of a nested call and of an
   * unrelated concurrent one.  Treating the concurrent caller as nested makes it JOIN —
   * it runs interleaved with the unit already in flight, under that unit's snapshot,
   * which is precisely the interleaving this seam removes.  Caught by the ordering test
   * below, which showed the second reviewer's unit starting inside the first's.
   *
   * `AsyncLocalStorage` propagates through the awaits of one async chain and NOT into a
   * chain started independently, which is exactly the distinction required.
   */
  readonly #ambient = new AsyncLocalStorage<ModerationTx>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(tx: ModerationTx, rollbacks: readonly InMemoryRollback[]) {
    this.#tx = tx;
    this.#rollbacks = rollbacks;
  }

  async run<T>(work: (tx: ModerationTx) => Promise<T>): Promise<T> {
    const ambient = this.#ambient.getStore();
    if (ambient !== undefined) return work(ambient); // genuinely nested — join it
    const running = this.#queue.then(() =>
      this.#ambient.run(this.#tx, async () => {
        const undo = this.#rollbacks.map((store) => store.beginRollback());
        try {
          return await work(this.#tx);
        } catch (error) {
          for (const restore of undo) restore();
          throw error;
        }
      }),
    );
    // The queue advances on SETTLEMENT, not on success: a unit that throws must still
    // release the next one, or one failure wedges every later write.
    this.#queue = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }
}
