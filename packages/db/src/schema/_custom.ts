// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drizzle does not ship a first-class `bytea` column, so we define one.  Used
// for session-token hashes, keyed IP hashes, WebAuthn public keys/credential
// ids, encrypted TOTP secrets, keyed wallet-address hashes, and persisted
// MinHash signatures — every place a raw secret, PII byte-string, or packed
// binary vector would otherwise sit in plaintext/inflated form.
import { customType, timestamp } from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * PostgreSQL full-text `tsvector` (WS-F.3.1a).  Used only for GENERATED
 * ALWAYS AS … STORED search columns — application code never writes one
 * directly, so the data type is the serialized lexeme form for reads.
 */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * A point in time, at the resolution this application can actually represent.
 *
 * `timestamptz` defaults to MICROSECOND precision.  Nothing here can hold one:
 * every timestamp is produced by, and read back through, a JavaScript `Date`,
 * which is milliseconds.  So the extra three digits are write-only — the
 * database keeps a value no caller can round-trip, and the mismatch is not
 * inert.  It silently deletes rows from paged reads.
 *
 * A keyset cursor is a value the app read out of the column (`…, id) < (cursor,
 * id)`).  Read back through a `Date` it has been rounded DOWN, so it names an
 * instant strictly BEFORE the row it came from, and in a descending page every
 * row sharing that millisecond with more microseconds sorts after the cursor
 * and is skipped — permanently, because the next cursor moves further away.
 * The id tiebreaker cannot save it: ids are compared only once the timestamps
 * compare EQUAL, which a rounded cursor never does against its own row.  And
 * the page just comes back SHORT, which is exactly how a caller decides it has
 * reached the end — so a moderation-notice DSAR export, or a room's thread
 * scan, reports itself complete having dropped rows it never saw.
 *
 * Truncating in the query would have fixed the comparison and left the cause:
 * `date_trunc(…)` is not the indexed expression, so every paged read gives up
 * its index, and the next cursor written by hand would reintroduce the bug.
 * Declaring the precision removes the unrepresentable state instead — Postgres
 * rounds on write, the column holds what a `Date` holds, and cursors are plain
 * indexed comparisons again.
 *
 * `check:timestamp-precision` is why this is the ONLY way to declare one:
 * a bare `timestamp(…)` in a schema file fails the build.  Four schema files
 * had already each written this helper locally, which is the whole argument
 * for it living here.
 */
export const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
