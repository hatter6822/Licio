// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared in-memory unit of work, tested where both domains meet.
//
// The property that is easy to state and easy to get wrong: a NESTED call joins the
// ambient unit, and a CONCURRENT one does not.  A depth counter satisfies the first and
// silently fails the second — it is equally true for both — so a second request arriving
// mid-unit joins, runs interleaved inside it, and commits as part of it.  That is the
// interleaving a unit of work exists to prevent, reintroduced by its own guard.
//
// It shipped that way in `InMemoryComplianceTransactor` while `runChainedUnit` was being
// driven from concurrent HTTP handlers, and production never showed it: the Drizzle
// transactor opens a real transaction per call and has no counter, so the divergence
// lived only where the tests run.
import { describe, expect, it } from 'vitest';
import type { InMemoryRollback } from '../lib/in-memory-rollback.js';
import { mapRollback } from '../lib/in-memory-rollback.js';
import { InMemoryUnitOfWork } from '../lib/in-memory-unit-of-work.js';

/** A store standing in for any of the real ones: a Map, replaced never mutated. */
class Rows implements InMemoryRollback {
  readonly rows = new Map<string, string>();
  beginRollback(): () => void {
    return mapRollback(this.rows);
  }
}

function unit(): { uow: InMemoryUnitOfWork<Rows>; store: Rows } {
  const store = new Rows();
  return { uow: new InMemoryUnitOfWork(store, [store]), store };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe('InMemoryUnitOfWork', () => {
  it('SERIALISES concurrent units — the second cannot start inside the first', async () => {
    const { uow, store } = unit();
    const order: string[] = [];
    let entered!: () => void;
    const aEntered = new Promise<void>((r) => {
      entered = r;
    });

    // B must arrive AFTER A is already inside its unit — two requests milliseconds
    // apart, not two calls in the same tick.  That timing is the whole test: issued in
    // one tick, both callers see an idle transactor and queue correctly even under a
    // depth counter, and the bug hides.
    const a = uow.run(async (s) => {
      order.push('a:enter');
      entered();
      s.rows.set('k', 'a');
      await tick();
      await tick();
      order.push('a:exit');
    });
    const b = (async () => {
      await aEntered;
      await uow.run(async (s) => {
        order.push('b:enter');
        s.rows.set('k', 'b');
        order.push('b:exit');
      });
    })();
    await Promise.all([a, b]);

    // No interleaving.  Under the depth-counter guard this reads
    // `a:enter | b:enter | b:exit | a:exit` — B running INSIDE A.
    expect(order).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit']);
    expect(store.rows.get('k')).toBe('b');
  });

  it('does not let a concurrent unit be rolled back by the one it arrived during', async () => {
    const { uow, store } = unit();
    let entered!: () => void;
    const aEntered = new Promise<void>((r) => {
      entered = r;
    });

    // A fails.  B arrived while A was in flight and must be untouched by A's rollback —
    // joined into A's unit it would share A's snapshot and lose its own write, which is
    // a committed request silently undone by an unrelated failure.
    const a = uow
      .run(async (s) => {
        entered();
        s.rows.set('a', 'yes');
        await tick();
        await tick();
        throw new Error('A failed');
      })
      .catch(() => 'failed');
    const b = (async () => {
      await aEntered;
      await uow.run(async (s) => {
        s.rows.set('b', 'yes');
      });
    })();
    await Promise.all([a, b]);

    expect(store.rows.has('a')).toBe(false); // A rolled back
    expect(store.rows.get('b')).toBe('yes'); // B survived it
  });

  it('JOINS a genuinely nested unit rather than waiting on its own queue', async () => {
    const { uow } = unit();
    // Serialised without the join this deadlocks: the inner call queues behind a slot its
    // own caller is holding, and neither ever completes.
    const seen = await uow.run(async (outer) => {
      outer.rows.set('k', 'outer');
      return uow.run(async (inner) => inner.rows.get('k'));
    });
    // The nested call sees the outer unit's UNCOMMITTED write, because it is the same
    // unit — what a savepoint-free nested transaction gives in Postgres.
    expect(seen).toBe('outer');
  });

  it('ROLLS BACK every participating store when the unit throws', async () => {
    const { uow, store } = unit();
    store.rows.set('kept', 'before');

    await expect(
      uow.run(async (s) => {
        s.rows.set('kept', 'during');
        s.rows.set('added', 'during');
        throw new Error('unit failed');
      }),
    ).rejects.toThrow('unit failed');

    expect(store.rows.get('kept')).toBe('before');
    expect(store.rows.has('added')).toBe(false);
  });

  it('a FAILED unit still releases the queue', async () => {
    const { uow, store } = unit();
    // The queue must advance on settlement, not on success — otherwise one failure wedges
    // every later write, and the symptom is a hang rather than an error.
    await expect(uow.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await uow.run(async (s) => {
      s.rows.set('after', 'ok');
    });
    expect(store.rows.get('after')).toBe('ok');
  });

  it('rolls back ONLY the failed unit, not the one that ran before it', async () => {
    const { uow, store } = unit();
    await uow.run(async (s) => {
      s.rows.set('committed', 'yes');
    });
    await expect(
      uow.run(async (s) => {
        s.rows.set('doomed', 'yes');
        throw new Error('nope');
      }),
    ).rejects.toThrow();

    // The snapshot is taken per unit, so an earlier unit's committed write survives.
    // Sharing one snapshot across joined units — the depth-counter failure mode — would
    // have taken this with it.
    expect(store.rows.get('committed')).toBe('yes');
    expect(store.rows.has('doomed')).toBe(false);
  });
});
