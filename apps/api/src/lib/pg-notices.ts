// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which pino level a Postgres NOTICE deserves.
//
// `createDbClient` preserves each notice's severity — that is most of why the
// projection keeps the field at all — but the boot then logged every one of them
// at `debug`, and `LOG_LEVEL` defaults to `info` in production.  A Postgres
// `WARNING` (a deprecated cast, a transaction wrapped around a non-transactional
// statement, a PL/pgSQL `RAISE WARNING` a migration left behind) was therefore
// dropped before it reached an operator, while the comment beside the sink said
// server diagnostics reach the logger.  Severity is the whole signal a notice
// carries; flattening it discards exactly the notices worth reading.
//
// The severity string is postgres.js's NON-LOCALIZED field (protocol `V`, added
// in PostgreSQL 9.6), never the localized `severity_local`, so these comparisons
// are safe under any server `lc_messages`.

/** The pino levels a notice may be logged at. */
export type PgNoticeLogLevel = 'warn' | 'info' | 'debug';

/**
 * Severities that reach a client through a NoticeResponse, by level.
 *
 * `ERROR`/`FATAL`/`PANIC` are absent deliberately: those arrive as a thrown
 * query error, not as a notice, and are logged where they are caught.
 */
const NOTICE_LEVELS: ReadonlyMap<string, PgNoticeLogLevel> = new Map([
  ['WARNING', 'warn'],
  ['NOTICE', 'info'],
  ['INFO', 'info'],
  ['LOG', 'info'],
  // `DEBUG1`..`DEBUG5` only arrive when `client_min_messages` is turned down,
  // which is a deliberate act of debugging.
  ['DEBUG', 'debug'],
  ['DEBUG1', 'debug'],
  ['DEBUG2', 'debug'],
  ['DEBUG3', 'debug'],
  ['DEBUG4', 'debug'],
  ['DEBUG5', 'debug'],
]);

/**
 * The level for one notice severity.
 *
 * An unrecognised severity logs at `info` rather than `debug`: this is a
 * diagnostic channel, so the safe direction for something the mapping does not
 * know is VISIBLE, not silent.  A server older than 9.6 sends no non-localized
 * severity at all, and the projection's `NOTICE` fallback lands here too.
 */
export function pgNoticeLogLevel(severity: string): PgNoticeLogLevel {
  return NOTICE_LEVELS.get(severity.trim().toUpperCase()) ?? 'info';
}
