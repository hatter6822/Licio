// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2/1.5 — the server non-storage contract, enforced as a STRUCTURAL
// column allowlist on the two private-room server tables (PRIVATE_SPEC §8.1,
// §8.2, §23.10).  The §8.1 forbiddance list is the column DENYLIST; the §8.2
// allowed-data list is the column ALLOWLIST.  This is the single source of
// truth shared by the `private-room-axes` db unit test AND the
// `check:private-rendezvous-schema` CI gate, so producer and gate never drift.
//
// The allowlist is the primary guarantee: any column NOT in the §8.2 set is a
// release-blocking violation (a new content/CID/member column cannot exist
// because the table would fail this check).  The forbidden-segment scan is
// defense-in-depth — it catches an obviously-private name even if someone
// extended the allowlist carelessly.  Neither list false-positives on a §8.2
// field (e.g. `display_avatar_public_cid` is an ALLOWED public CID, so the scan
// forbids `private_cid`, never bare `cid`; `manifest_key_commitment` is an
// ALLOWED commitment, so the scan never forbids bare `manifest`).
import { getTableColumns, getTableName, is, Table } from 'drizzle-orm';
import * as schema from './schema/index.js';
import * as privateRoomSchema from './schema/private-room.js';

/** §8.2 — the EXACT set of columns `private_room_stubs` may carry. */
export const PRIVATE_ROOM_STUB_ALLOWED_COLUMNS: readonly string[] = [
  'stub_id',
  'room_server_id',
  'directory_mode',
  'display_name',
  'display_description',
  'display_avatar_public_cid',
  'room_public_key',
  'manifest_key_commitment',
  'latest_manifest_commitment',
  'rendezvous_policy',
  'bootstrap_hints',
  'signed_stub',
  'stub_signature',
  'created_by_account_id',
  'created_at',
  'updated_at',
];

/** §15.3 — the EXACT set of columns `private_rendezvous_records` may carry. */
export const PRIVATE_RENDEZVOUS_ALLOWED_COLUMNS: readonly string[] = [
  'rendezvous_id',
  'room_blind_id',
  'peer_blind_id',
  'encrypted_announcement',
  'expires_at',
  'created_at',
];

/**
 * The per-table §8.2 allowlists, keyed by SQL table name.
 *
 * This map is the only hand-maintained part, and it is deliberately NOT the
 * list of tables to check — {@link privateServerTables} derives that from the
 * schema. A private-room table with no entry here is a VIOLATION
 * (`unregistered_table`), not a table that is quietly skipped: the guard used to
 * carry a two-element array of `{name, table, allowed}` triples, so a third
 * private-room table was checked against nothing at all and the gate stayed
 * green while the server grew a column the non-storage contract forbids.
 */
const PRIVATE_TABLE_ALLOWLISTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['private_room_stubs', PRIVATE_ROOM_STUB_ALLOWED_COLUMNS],
  ['private_rendezvous_records', PRIVATE_RENDEZVOUS_ALLOWED_COLUMNS],
]);

/**
 * The table names that HAVE a §8.2 allowlist.
 *
 * Exported for the migration-chain parity test, which asks the complementary
 * question this module cannot: a `CREATE TABLE "private_room_op_heads"` with no
 * matching `pgTable` export is a live server table that no Drizzle-side
 * enumeration can see.
 */
export const PRIVATE_ALLOWLISTED_TABLE_NAMES: readonly string[] = [
  ...PRIVATE_TABLE_ALLOWLISTS.keys(),
].sort();

/** Every Drizzle table value a module namespace exports, with its SQL name. */
function tablesIn(namespace: Record<string, unknown>): Array<{ name: string; table: Table }> {
  const found: Array<{ name: string; table: Table }> = [];
  for (const value of Object.values(namespace)) {
    if (is(value, Table)) found.push({ name: getTableName(value), table: value });
  }
  return found;
}

/**
 * The private-room server tables, DERIVED rather than listed.
 *
 * A table is in scope when either is true:
 *
 *  - it is exported by `schema/private-room.ts` — the module that exists to hold
 *    exactly these tables; or
 *  - its SQL name begins with `private_`, wherever in the schema it is declared,
 *    so moving or renaming a file cannot drop a table out of scope.
 *
 * Both rules are needed. The first catches a private-room table given an
 * unprefixed name; the second catches one added to a different schema module.
 * `allowed` is `undefined` when the table has no §8.2 allowlist yet, which
 * {@link checkPrivateServerTables} reports rather than skips.
 */
export function privateServerTables(): ReadonlyArray<{
  name: string;
  table: Table;
  allowed: readonly string[] | undefined;
}> {
  const inScope = new Map<string, Table>();
  for (const { name, table } of tablesIn(privateRoomSchema)) inScope.set(name, table);
  for (const { name, table } of tablesIn(schema)) {
    if (name.startsWith('private_')) inScope.set(name, table);
  }
  return [...inScope.entries()]
    .map(([name, table]) => ({ name, table, allowed: PRIVATE_TABLE_ALLOWLISTS.get(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * §8.1 — column-name segments that may NEVER appear on a private-room server
 * table.  Each is unambiguous: none is a substring of any §8.2-allowed field.
 * (We forbid `private_cid`, not bare `cid`, because the listed-avatar public
 * CID is allowed; we never forbid `manifest`/`key` because the manifest-key
 * COMMITMENT and room PUBLIC key are allowed commitments.)
 */
export const FORBIDDEN_PRIVATE_COLUMN_SEGMENTS: readonly string[] = [
  'plaintext',
  'op_head',
  'op_id',
  'operation',
  'story',
  'thread',
  'contribution',
  'member',
  'unread',
  'activity',
  'push',
  'embedding',
  'search',
  'topic',
  'canonical',
  'invite',
  'recovery',
  'secret',
  'private_key',
  'private_cid',
  'root_key',
  'key_material',
  'media',
  'thumbnail',
  'attention',
  'ranking',
  'body',
  'title',
];

export interface PrivateRoomGuardViolation {
  table: string;
  /** Empty for a whole-table finding (`unregistered_table`). */
  column: string;
  reason: 'not_in_allowlist' | 'forbidden_segment' | 'unregistered_table';
  detail?: string;
}

/** Return the SQL column names of a Drizzle table. */
export function privateTableColumnNames(table: Table): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

/**
 * Check every private-room server table against the §8.2 allowlist AND the §8.1
 * forbidden-segment denylist.  Returns every violation (empty ⇒ clean).  Pure +
 * database-free: it introspects the Drizzle table definitions, which are the
 * migration's source of truth, so it runs in CI on every PR.
 *
 * The table set comes from {@link privateServerTables}, so adding a private-room
 * table without deciding its §8.2 columns fails here — the allowlist cannot be
 * bypassed by declaring a table the guard was never told about.
 */
export function checkPrivateServerTables(): PrivateRoomGuardViolation[] {
  const violations: PrivateRoomGuardViolation[] = [];
  for (const { name, table, allowed } of privateServerTables()) {
    if (allowed === undefined) {
      violations.push({
        table: name,
        column: '',
        reason: 'unregistered_table',
        detail:
          'private-room server table with no §8.2 column allowlist — add one to PRIVATE_TABLE_ALLOWLISTS',
      });
      continue;
    }
    const allowedSet = new Set(allowed);
    for (const column of privateTableColumnNames(table)) {
      if (!allowedSet.has(column)) {
        violations.push({ table: name, column, reason: 'not_in_allowlist' });
      }
      const lower = column.toLowerCase();
      for (const segment of FORBIDDEN_PRIVATE_COLUMN_SEGMENTS) {
        if (lower.includes(segment)) {
          violations.push({ table: name, column, reason: 'forbidden_segment', detail: segment });
        }
      }
    }
  }
  return violations;
}
