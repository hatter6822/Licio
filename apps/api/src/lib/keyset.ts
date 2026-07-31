// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EXACT keyset pagination over a `(timestamp, id)` order.
//
// The obvious spelling of a keyset cursor is wrong here, and wrong in a way no type
// catches.  A page ends, the caller encodes the last row's timestamp and id, and the next
// page asks for rows before (or after) that pair.  But the timestamp the caller holds is
// not the timestamp Postgres holds:
//
//   * `timestamptz` has MICROSECOND resolution.
//   * The driver returns a JS `Date`, which has MILLISECOND resolution.
//
// The value is rounded DOWN before any application code sees it, so the encoded cursor
// names an instant strictly earlier than the row it came from.  In a DESC walk the next
// page's `<` then excludes every row sharing that millisecond with fewer microseconds —
// they are silently DROPPED.  In an ASC walk the `>` re-includes rows already served —
// duplicates, and if a whole page shares one millisecond the cursor never advances and
// the walk does not terminate.
//
// Measured against this project's database, five back-to-back `now()` inserts landed on
// .590531 / .591106 / .591394 / .591673 / .591967: one cursor, three rows lost.  Bursts
// are what cluster inside a millisecond, so the busiest moments lose the most.
//
// The fix is to stop round-tripping the timestamp at all.  The cursor's ID is exact, so
// the row's own stored values are recoverable from the table — and comparing the order
// key against the row's TRUE position is what the cursor meant in the first place.
//
// In-memory adapters do not reproduce the bug (their timestamps come from `Date.now()`,
// so there is no sub-millisecond to lose) which is exactly why it survived: the defect
// exists only in the adapter that no unit test exercises.
import type { Column } from 'drizzle-orm';
import { type SQL, sql } from 'drizzle-orm';

/**
 * `(sortColumn, idColumn) <|> (the row identified by `id`)` — the exact keyset predicate.
 *
 * The subquery re-reads the boundary row's stored values, so no timestamp crosses the
 * wire and nothing is rounded.  Both sides stay on the RAW columns, so the ordering this
 * pairs with (`ORDER BY sortColumn, idColumn`) can still use an ordinary btree index.
 *
 * The inner `FROM` deliberately carries NO alias: an alias would leave `${sortColumn}`
 * rendering the outer table's name and silently correlate the subquery to the outer row.
 * Unaliased, the inner scope shadows the outer one and every reference binds inward,
 * which is what this needs.
 *
 * An `id` matching no row yields NULL ⇒ the comparison is unknown ⇒ the page comes back
 * empty.  That is the safe direction: a cursor pointing at a vanished row ENDS the walk
 * rather than silently restarting it from the head, which would loop a paging reader
 * forever while looking like progress.
 */
export function keysetAfterRow(
  sortColumn: Column,
  idColumn: Column,
  id: string,
  direction: 'asc' | 'desc',
): SQL {
  const table = idColumn.table;
  const comparison = direction === 'asc' ? sql.raw('>') : sql.raw('<');
  return sql`(${sortColumn}, ${idColumn}) ${comparison} (SELECT ${sortColumn}, ${idColumn} FROM ${table} WHERE ${idColumn} = ${id}::uuid)`;
}
