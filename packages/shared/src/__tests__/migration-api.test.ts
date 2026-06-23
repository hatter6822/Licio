// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — the migration wire contracts.  Pins `migrationImportModeSchema` to the
// `PRIVATE_ROOM_IMPORT_MODES` copy SSOT (so the wire enum and the wizard's modes
// can never drift), and exercises the export/freeze/purge envelope shapes.
import { describe, expect, it } from 'vitest';
import { PRIVATE_ROOM_IMPORT_MODES } from '../constants/private-rooms.js';
import {
  migrationExportResponseSchema,
  migrationFreezeResponseSchema,
  migrationImportModeSchema,
  migrationPurgeRequestSchema,
  migrationSourceItemSchema,
} from '../schemas/migration-api.js';

describe('WS-S.9 migration wire contracts', () => {
  it('the import-mode enum matches the §24.2 copy SSOT (no drift)', () => {
    const ssot = PRIVATE_ROOM_IMPORT_MODES.map((m) => m.id).sort();
    const wire = [...migrationImportModeSchema.options].sort();
    expect(wire).toStrictEqual(ssot);
  });

  it('a source item accepts the planMigration shape and rejects applause fields', () => {
    const ok = migrationSourceItemSchema.safeParse({
      id: 'story-1',
      kind: 'story',
      title: 'A title',
      threadRef: 'thread-1',
    });
    expect(ok.success).toBe(true);
    // No score/like/vote field is part of the contract (no-applause doctrine):
    // unknown keys are stripped by zod, never carried.
    const stripped = migrationSourceItemSchema.parse({
      id: 'c1',
      kind: 'contribution',
      body: 'hi',
      score: 99,
    } as Record<string, unknown>);
    expect('score' in stripped).toBe(false);
  });

  it('the export response carries the room label + items', () => {
    const parsed = migrationExportResponseSchema.parse({
      room_id: '00000000-0000-4000-8000-000000000001',
      room_name: 'Old Room',
      room_label: 'Members-only server room',
      frozen: false,
      items: [{ id: 's1', kind: 'story', title: 'T' }],
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.frozen).toBe(false);
  });

  it('the freeze response forces frozen=true', () => {
    expect(
      migrationFreezeResponseSchema.safeParse({
        room_id: '00000000-0000-4000-8000-000000000001',
        frozen: false,
        migrated_to_room_id: null,
      }).success,
    ).toBe(false);
  });

  it('the purge request only accepts purge|anonymize', () => {
    expect(migrationPurgeRequestSchema.safeParse({ mode: 'purge' }).success).toBe(true);
    expect(migrationPurgeRequestSchema.safeParse({ mode: 'delete' }).success).toBe(false);
  });
});
