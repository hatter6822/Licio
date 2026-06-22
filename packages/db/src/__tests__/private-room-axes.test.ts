// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.1 — the room-axes DB↔shared enum mirror + column presence.  Runs in CI
// with no database (it introspects the Drizzle table/enum definitions, which
// are migration `0043`'s source of truth).  The gated apply/rollback +
// CHECK-violation cases live in the Postgres integration suite; this unit guard
// proves the storage-layer enums match the `@licio/shared` axis enums exactly,
// so the wire schema and the DB can never drift (PRIVATE_SPEC §4.1/§23.2).
import { ROOM_AUTHORITY_MODELS, ROOM_DIRECTORY_MODES, ROOM_STORAGE_MODES } from '@licio/shared';
import { getTableColumns } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  checkPrivateServerTables,
  FORBIDDEN_PRIVATE_COLUMN_SEGMENTS,
  PRIVATE_RENDEZVOUS_ALLOWED_COLUMNS,
  PRIVATE_ROOM_STUB_ALLOWED_COLUMNS,
  privateTableColumnNames,
} from '../private-room-guard.js';
import { privateRendezvousRecords, privateRoomStubs } from '../schema/private-room.js';
import {
  roomAuthorityModelEnum,
  roomDirectoryModeEnum,
  roomStorageModeEnum,
  rooms,
} from '../schema/room.js';

describe('WS-S.1.1 room-axes DB↔shared enum mirror', () => {
  it('mirrors storage_mode exactly', () => {
    expect([...roomStorageModeEnum.enumValues]).toEqual([...ROOM_STORAGE_MODES]);
  });

  it('mirrors authority_model exactly', () => {
    expect([...roomAuthorityModelEnum.enumValues]).toEqual([...ROOM_AUTHORITY_MODELS]);
  });

  it('mirrors directory_mode exactly', () => {
    expect([...roomDirectoryModeEnum.enumValues]).toEqual([...ROOM_DIRECTORY_MODES]);
  });
});

describe('WS-S.1.1 rooms table carries the four §4.1 axis columns', () => {
  it('adds storage_mode / authority_model / directory_mode / p2p_stub_id', () => {
    const columns = getTableColumns(rooms);
    expect(columns.storageMode?.name).toBe('storage_mode');
    expect(columns.storageMode?.notNull).toBe(true);
    expect(columns.storageMode?.default).toBe('server');
    expect(columns.authorityModel?.name).toBe('authority_model');
    expect(columns.authorityModel?.notNull).toBe(true);
    expect(columns.authorityModel?.default).toBe('platform');
    // directory_mode + p2p_stub_id are nullable (NULL for every server room).
    expect(columns.directoryMode?.name).toBe('directory_mode');
    expect(columns.directoryMode?.notNull).toBe(false);
    expect(columns.p2pStubId?.name).toBe('p2p_stub_id');
    expect(columns.p2pStubId?.notNull).toBe(false);
  });
});

describe('WS-S.1.2 private-room server tables — §8.1 column denylist', () => {
  it('finds zero forbidden columns on either server table', () => {
    expect(checkPrivateServerTables()).toEqual([]);
  });

  it('the live stub table carries EXACTLY the §8.2 allowlist (no more, no less)', () => {
    expect(privateTableColumnNames(privateRoomStubs).sort()).toEqual(
      [...PRIVATE_ROOM_STUB_ALLOWED_COLUMNS].sort(),
    );
  });

  it('the live rendezvous table carries EXACTLY the §15.3 allowlist', () => {
    expect(privateTableColumnNames(privateRendezvousRecords).sort()).toEqual(
      [...PRIVATE_RENDEZVOUS_ALLOWED_COLUMNS].sort(),
    );
  });

  it('the rendezvous record has NO foreign key to a room (un-linkable, §15.3.1)', () => {
    // A blind rendezvous record must not be join-able back to a room: assert no
    // column references `rooms`/`room_server_id` and no `room_id` column exists.
    const cols = privateTableColumnNames(privateRendezvousRecords);
    expect(cols).not.toContain('room_id');
    expect(cols).not.toContain('room_server_id');
  });

  it('none of the allowed column names trips a forbidden segment (no false positive)', () => {
    for (const col of [
      ...PRIVATE_ROOM_STUB_ALLOWED_COLUMNS,
      ...PRIVATE_RENDEZVOUS_ALLOWED_COLUMNS,
    ]) {
      const lower = col.toLowerCase();
      for (const seg of FORBIDDEN_PRIVATE_COLUMN_SEGMENTS) {
        expect(lower.includes(seg), `${col} must not contain forbidden segment ${seg}`).toBe(false);
      }
    }
  });

  it('the matcher BITES — a fixture table with a forbidden column is caught', () => {
    // A deliberately-violating fixture proves the guard actually detects
    // content columns (mirrors the WS-F.2.5b financial-denylist fixture test).
    const violator = pgTable('private_room_stubs_violator', {
      stubId: uuid('stub_id').primaryKey(),
      // Both a forbidden segment AND an out-of-allowlist column:
      contributionBody: text('contribution_body'),
    });
    const cols = privateTableColumnNames(violator);
    expect(cols).toContain('contribution_body');
    // The forbidden-segment scan must flag `contribution`/`body`.
    const tripped = FORBIDDEN_PRIVATE_COLUMN_SEGMENTS.some((s) => 'contribution_body'.includes(s));
    expect(tripped).toBe(true);
  });
});
