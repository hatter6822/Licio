// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A store built over `DbOrTx` must make its own atomicity (WS-N).
//
// WHY THIS GATE EXISTS.  `type DbOrTx = Db | Tx` hides the one difference that
// matters: handed a transaction, a method's statements are atomic; handed the
// POOL, each statement is its own transaction — so the identical code races,
// and a `SELECT … FOR UPDATE` releases its lock the instant its statement ends.
//
// `applyLegalHold` shipped with a row lock that was correct for every
// production caller (all inside a unit) and worthless for a direct one.  It
// passed review, passed local Postgres runs, and lost a concurrent legal hold
// exactly once — in CI, where the timing differed.  Nothing in the type, the
// tests, or the review caught it, because the hazard is invisible at the call
// site AND at the definition.
//
// So it is caught here instead.  The hazard is precisely READ-MODIFY-WRITE: a
// write whose value came from an earlier statement.  Split across two implicit
// transactions, another writer lands in the gap and the second write clobbers
// it — a lost update, silent, with no error anywhere.  Such a method must open
// its own transaction (a SAVEPOINT when nested, a real transaction on the pool
// — correct either way).
//
// Deliberately NOT flagged, because neither can lose an update:
//   • several reads (a torn read here fails closed, and READ COMMITTED gives
//     per-statement snapshots inside a transaction anyway, so wrapping would
//     buy nothing without raising the isolation level);
//   • a write FIRST, then a read (`record`: insert … on conflict do nothing,
//     then re-read the winner) — nothing is computed from the read.
//
// A static scan is crude, but it is the only thing that reads every method,
// including the one written next month by someone who never saw this comment.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const STORE_FILES = [
  'src/compliance/drizzle-compliance-stores.ts',
  'src/knomosis/drizzle-knomosis-stores.ts',
] as const;

/** A statement issued directly against the store's handle, tagged read/write. */
const HANDLE_STATEMENT = /await this\.#db\s*\n?\s*\.(select|insert|update|delete|execute)/g;
const WRITE_VERBS = new Set(['insert', 'update', 'delete', 'execute']);

interface Method {
  name: string;
  /** A write that some earlier statement could have fed — the lost-update shape. */
  readModifyWrite: boolean;
  wraps: boolean;
}

/** Every method in a class body, and whether it read-modify-writes unguarded. */
function methodsOf(source: string): Method[] {
  const methods: Method[] = [];
  // Methods are two-space indented and end at the matching two-space `}`.
  for (const match of source.matchAll(/^ {2}(?:async )?#?(\w+)\(([\s\S]*?)\n {2}\}\n/gm)) {
    const [, name = '', body = ''] = match;
    const verbs = [...body.matchAll(HANDLE_STATEMENT)].map((m) => m[1] ?? '');
    methods.push({
      name,
      readModifyWrite: verbs.some((verb, i) => i > 0 && WRITE_VERBS.has(verb)),
      wraps: body.includes('this.#db.transaction('),
    });
  }
  return methods;
}

describe('a store over DbOrTx makes its OWN atomicity', () => {
  it.each(STORE_FILES)('%s: no multi-statement method rides the caller’s transaction', (file) => {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    // Sanity: the scan must actually be reading methods, or it proves nothing.
    const methods = methodsOf(source);
    expect(methods.length).toBeGreaterThan(10);

    const unguarded = methods.filter((m) => m.readModifyWrite && !m.wraps).map((m) => m.name);
    // A write computed from an earlier statement is atomic ONLY when `#db`
    // happens to be a transaction — which the type does not promise and the
    // caller need not provide.  Wrap it (`this.#db.transaction(...)`) or make
    // it one statement.
    expect(unguarded).toEqual([]);
  });

  it('detects the hazard it is meant to detect', () => {
    // The gate is worthless if the scan cannot see the shape, so make it fail
    // on purpose: two statements, no transaction.
    const hazard = `
export class Example {
  readonly #db: DbOrTx;

  async readModifyWrite(id: string): Promise<void> {
    const rows = await this.#db
      .select()
      .from(t)
      .where(eq(t.id, id))
      .for('update');
    await this.#db
      .update(t)
      .set({ v: rows[0].v + 1 })
      .where(eq(t.id, id));
  }
}
`;
    const found = methodsOf(hazard).filter((m) => m.readModifyWrite && !m.wraps);
    expect(found.map((m) => m.name)).toEqual(['readModifyWrite']);

    // …and passes once the method owns its transaction.
    const fixed = hazard.replace(
      'const rows = await this.#db',
      'return await this.#db.transaction(async (tx) => {});\n    const rows = await this.#db',
    );
    expect(methodsOf(fixed).filter((m) => m.readModifyWrite && !m.wraps)).toEqual([]);

    // …and a write FIRST then a read is NOT the shape (the `record` pattern).
    const writeThenRead = hazard
      .replace('.select()', '.insert(t)')
      .replace('.update(t)', '.select()');
    expect(methodsOf(writeThenRead).filter((m) => m.readModifyWrite && !m.wraps)).toEqual([]);
  });
});
