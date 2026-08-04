// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The in-memory UNIT OF WORK, shared by every domain that has one.
//
// Each domain's transactor differs only in which stores its unit exposes, so the
// mechanics live here once.  They were written twice before, and the two copies had
// already diverged on the part that is easiest to get wrong.
//
// TWO PROPERTIES, both of which the Postgres side gets from the database and an in-memory
// twin has to arrange for itself:
//
//   ATOMICITY.  Snapshot before, restore on any throw.  Without it a failed unit leaves
//   its earlier writes behind, and the twin answers a different question from production
//   about what a failure costs.
//
//   ISOLATION.  Units run one at a time.  Postgres gives each transaction its own
//   snapshot; a fold over Maps makes every write visible the instant it happens, so two
//   units interleaving at any `await` observe each other's uncommitted state — which
//   Postgres would never show them.
//
// THE RE-ENTRANCY TEST IS ASYNC CONTEXT, NOT A COUNTER.  A nested call must JOIN the
// ambient unit: it is the same logical transaction, and under serialisation it would
// otherwise wait for a queue slot its own caller is holding, which is a deadlock rather
// than a delay.  But `if (depth > 0) join()` cannot tell a nested call from an unrelated
// CONCURRENT one — the counter is equally true for both — so a concurrent caller joins
// too, runs interleaved inside the in-flight unit, and commits as part of it.  That is
// the exact interleaving the seam exists to prevent, reintroduced by its own guard.
// `AsyncLocalStorage` propagates through the awaits of one async chain and NOT into a
// chain started independently, which is precisely the distinction required.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { InMemoryRollback } from './in-memory-rollback.js';

/**
 * ONE queue for every unit, because the state they protect is shared.
 *
 * Serialising per INSTANCE made "units run one at a time" true of each domain
 * and false of the runtime.  Five domains hold their own unit, and several of
 * them list the SAME participants — the audit store above all, since a durable
 * change and the record of it commit together everywhere.  So a forum unit and
 * an identity unit ran concurrently over one `InMemoryAuditStore`, and the
 * snapshot each took was of the whole store: when one failed, its restore put
 * back an array length from before the OTHER unit's append, deleting an audit
 * row whose change had already committed.  Atomicity for one unit, silently
 * taken out of another.
 *
 * The scope of the lock has to be the scope of the state, and the participants
 * are shared globally, so the lock is global.  This is an in-memory twin for
 * dev and tests — there is no throughput to protect, and a unit here is a few
 * Map writes.
 */
let sharedQueue: Promise<unknown> = Promise.resolve();

/**
 * Whether THIS async chain is already inside some unit — any unit, not just
 * this instance's.
 *
 * A nested call must never queue: it would wait for a slot its own caller
 * holds, which is a deadlock rather than a delay.  The per-instance ambient
 * below answers that for a call back into the SAME domain; with one shared
 * queue a call into a DIFFERENT domain has the same problem and needs the same
 * answer, so the marker is global too.
 */
const inUnit = new AsyncLocalStorage<{ undo: (() => void)[] }>();

export class InMemoryUnitOfWork<S> {
  readonly #stores: S;
  readonly #rollbacks: () => readonly InMemoryRollback[];
  readonly #ambient = new AsyncLocalStorage<S>();

  /**
   * @param rollbacks the participants, read at RUN time rather than captured.
   *
   * A composition root cannot always construct every participant before the unit
   * — the private-room stub store is built after the moderation services — and a
   * list fixed at construction silently excludes whatever came later. Reading it
   * per run removes the ordering constraint instead of documenting it.
   */
  constructor(
    stores: S,
    rollbacks: readonly InMemoryRollback[] | (() => readonly InMemoryRollback[]),
  ) {
    this.#stores = stores;
    this.#rollbacks = typeof rollbacks === 'function' ? rollbacks : () => rollbacks;
  }

  async run<T>(work: (stores: S) => Promise<T>): Promise<T> {
    const ambient = this.#ambient.getStore();
    if (ambient !== undefined) return work(ambient); // genuinely nested — join it

    // NESTED ACROSS DOMAINS — a moderation unit reaching into the forum's, say.
    // It is one logical transaction, so it joins the unit in flight rather than
    // opening its own: it runs inline (queueing behind its own caller would
    // deadlock), and its participants are snapshotted onto the OUTER unit's undo
    // list so a later failure rolls back the whole thing and not just the half
    // the outer unit happens to know about.
    const outer = inUnit.getStore();
    if (outer !== undefined) {
      outer.undo.push(...this.#rollbacks().map((store) => store.beginRollback()));
      return this.#ambient.run(this.#stores, () => work(this.#stores));
    }

    const running = sharedQueue.then(() =>
      this.#ambient.run(this.#stores, async () => {
        const undo = this.#rollbacks().map((store) => store.beginRollback());
        return inUnit.run({ undo }, async () => {
          try {
            return await work(this.#stores);
          } catch (error) {
            // Newest first: a nested unit's snapshot was taken after this one's,
            // so restoring it last would put back the state from before it.
            for (const restore of [...undo].reverse()) restore();
            throw error;
          }
        });
      }),
    );
    // The queue advances on SETTLEMENT, not on success: a unit that throws must still
    // release the next one, or one failure wedges every later write.
    sharedQueue = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }
}
