// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The in-memory adapters' ROLLBACK, in one place.
//
// The house rule is that the in-memory twins emulate every protection the database
// offers, and a transaction is one of them.  A twin that merely ran the callback would
// answer a different question from production about what a failed unit leaves behind —
// and a rollback only production performs is a rollback no test ever exercises.
//
// Shared rather than per-domain: WS-N and WS-J both need it, and two spellings of one
// contract is how the two drift.  Returning an undo CLOSURE keeps each store's snapshot
// private, so no row shape escapes through the transactor.

/** A store that can be put back the way it was. */
export interface InMemoryRollback {
  /** Capture the current rows; the returned closure puts them back. */
  beginRollback(): () => void;
}

/**
 * The rollback for a `Map`-backed store — which is nearly all of them.
 *
 * SHALLOW on purpose, and sound only because these stores REPLACE a row on every write
 * (`{ ...row, ...patch }` then `set`) rather than editing it in place.  That is a
 * convention, and not a universal one: `InMemoryContributionStore.applyEdit` assigns to
 * the stored object's fields, so a shallow snapshot would not restore it.  Any store
 * adopting this must be replace-only, and a store that mutates needs its own rollback.
 */
export function mapRollback<K, V>(rows: Map<K, V>): () => void {
  const saved = new Map(rows);
  return () => {
    rows.clear();
    for (const [key, value] of saved) rows.set(key, value);
  };
}
