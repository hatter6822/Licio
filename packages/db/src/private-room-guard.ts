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
import { getTableColumns, type Table } from 'drizzle-orm';
import { privateRendezvousRecords, privateRoomStubs } from './schema/private-room.js';

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

/** The two private-room server tables, keyed by SQL name, with their allowlist. */
export const PRIVATE_SERVER_TABLES: ReadonlyArray<{
  name: string;
  table: Table;
  allowed: readonly string[];
}> = [
  {
    name: 'private_room_stubs',
    table: privateRoomStubs,
    allowed: PRIVATE_ROOM_STUB_ALLOWED_COLUMNS,
  },
  {
    name: 'private_rendezvous_records',
    table: privateRendezvousRecords,
    allowed: PRIVATE_RENDEZVOUS_ALLOWED_COLUMNS,
  },
];

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
  column: string;
  reason: 'not_in_allowlist' | 'forbidden_segment';
  detail?: string;
}

/** Return the SQL column names of a Drizzle table. */
export function privateTableColumnNames(table: Table): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

/**
 * Check both private-room server tables against the §8.2 allowlist AND the §8.1
 * forbidden-segment denylist.  Returns every violation (empty ⇒ clean).  Pure +
 * database-free: it introspects the Drizzle table definitions, which are the
 * migration's source of truth, so it runs in CI on every PR.
 */
export function checkPrivateServerTables(): PrivateRoomGuardViolation[] {
  const violations: PrivateRoomGuardViolation[] = [];
  for (const { name, table, allowed } of PRIVATE_SERVER_TABLES) {
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
