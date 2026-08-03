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

export class InMemoryUnitOfWork<S> {
  readonly #stores: S;
  readonly #rollbacks: () => readonly InMemoryRollback[];
  readonly #ambient = new AsyncLocalStorage<S>();
  #queue: Promise<unknown> = Promise.resolve();

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
    const running = this.#queue.then(() =>
      this.#ambient.run(this.#stores, async () => {
        const undo = this.#rollbacks().map((store) => store.beginRollback());
        try {
          return await work(this.#stores);
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
