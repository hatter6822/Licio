// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — the server-room → Private-P2P-room migration wire contracts
// (PRIVATE_SPEC §24).  A Members-only server room is NEVER upgraded in place:
// the owner/steward exports the old room's content (read-only), re-authors the
// chosen scope into a NEW client-created P2P room, freezes the old room
// read-only (phase 5), and purges/minimizes the old server content (phase 6).
//
// These schemas cross the trust boundary, so the client (zod-on-response,
// WS-C.1.2) and the server validate identically.  The export response carries
// items in the `MigrationSourceItem` shape the `@licio/private-p2p`
// `planMigration` core consumes — that engine is the SSOT for the import-mode
// decision; this is only the wire envelope.
import { z } from 'zod';
import { uuidSchema } from './common.js';

/** The §24.2 import modes (mirrors `PRIVATE_ROOM_IMPORT_MODES` ids in
 *  `constants/private-rooms.ts` — pinned by a unit test so they cannot drift). */
export const migrationImportModeSchema = z.enum(['fresh', 'selected', 'full', 'redacted']);
export type MigrationImportMode = z.infer<typeof migrationImportModeSchema>;

/**
 * One historical server item, projected into the shape `planMigration` reads
 * (`MigrationSourceItem` in `@licio/private-p2p`).  Bodies are the verbatim
 * Markdown-lite / submission text; the client re-encrypts them into the P2P
 * room.  No applause/attention fields ever appear here (no-applause doctrine).
 */
export const migrationSourceItemSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['story', 'contribution']),
  title: z.string().max(2000).optional(),
  summary: z.string().max(8000).optional(),
  body: z.string().max(200_000).optional(),
  /** The thread/story this belongs to, so the P2P DAG mirrors structure. */
  threadRef: z.string().min(1).max(128).optional(),
  parentRef: z.string().min(1).max(128).optional(),
});
export type MigrationSourceItemWire = z.infer<typeof migrationSourceItemSchema>;

/**
 * `GET`-shaped read of the old room's exportable content (phase 1/3 input).
 * Returns the room's label + every story and its published contributions in
 * source-item shape, so the wizard can plan the import and re-author locally.
 */
export const migrationExportResponseSchema = z.object({
  room_id: uuidSchema,
  room_name: z.string().min(1).max(100),
  /** The §20.1 honest label for the OLD room (always the Members-only label). */
  room_label: z.string().min(1),
  items: z.array(migrationSourceItemSchema),
  /** True once the room is frozen (phase 5 already ran) — the wizard reflects it. */
  frozen: z.boolean(),
});
export type MigrationExportResponse = z.infer<typeof migrationExportResponseSchema>;

/**
 * Phase-5 freeze request: the OPAQUE client-side P2P room id the old room now
 * points at (a UUID — a Private P2P room has no server row, so this is never an
 * FK).  Optional so a steward can freeze before the destination id is known
 * (e.g. abort), though the wizard always supplies it.
 */
export const migrationFreezeRequestSchema = z.object({
  migrated_to_room_id: uuidSchema.optional(),
});
export type MigrationFreezeRequest = z.infer<typeof migrationFreezeRequestSchema>;

export const migrationFreezeResponseSchema = z.object({
  room_id: uuidSchema,
  frozen: z.literal(true),
  migrated_to_room_id: uuidSchema.nullable(),
});
export type MigrationFreezeResponse = z.infer<typeof migrationFreezeResponseSchema>;

/**
 * Phase-6 purge request.  `mode` chooses the §24 minimization:
 *   • `purge`     — remove the old server content (stories taken down, the
 *                   user's contributions tombstoned/anonymized);
 *   • `anonymize` — keep the content but detach authors (the WS-Q DSAR path).
 * `purge` requires the room to already be FROZEN (phase 5 first), enforced
 * server-side (fail-closed).
 */
export const migrationPurgeRequestSchema = z.object({
  mode: z.enum(['purge', 'anonymize']),
});
export type MigrationPurgeRequest = z.infer<typeof migrationPurgeRequestSchema>;

export const migrationPurgeResponseSchema = z.object({
  room_id: uuidSchema,
  mode: z.enum(['purge', 'anonymize']),
  /** Count of stories removed/anonymized (phase-6 honesty: what was minimized). */
  stories_affected: z.number().int().nonnegative(),
});
export type MigrationPurgeResponse = z.infer<typeof migrationPurgeResponseSchema>;
