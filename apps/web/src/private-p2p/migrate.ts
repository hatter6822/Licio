// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — the apps/web migration helper (PRIVATE_SPEC §24).  It ties the
// server-side export/freeze/purge surface to the CLIENT-LOCAL re-authoring into
// a new Private P2P room:
//
//   1. `fetchMigrationExport` reads the old room's content (server, read-only);
//   2. `reauthorIntoPrivateRoom` runs the §24.2 `planMigration` decision core
//      (loaded by DYNAMIC import — `check:private-p2p-split` forbids a static
//      value import of `@licio/private-p2p`) over the export, then re-authors
//      each planned item into the destination `PrivateRoomSession` (which
//      ENCRYPTS as it authors — the server never sees the re-encrypted content);
//   3. `freezeMigratedRoom` / `purgeMigratedRoom` drive phases 5 + 6.
//
// The crypto/protocol core stays off the initial bundle: this module imports
// `PrivateRoomSession` (already a dynamic-import wrapper) and pulls `planMigration`
// in lazily.  Doctrine: migration improves privacy going forward but cannot make
// past server access impossible — the wizard renders that §24.3 disclosure
// (PRIVATE_ROOM_MIGRATION_WARNING) before any re-author/freeze/purge step.

import {
  type MigrationExportResponse,
  type MigrationImportMode,
  migrationExportResponseSchema,
  migrationFreezeResponseSchema,
  migrationPurgeResponseSchema,
} from '@licio/shared';
import type { z } from 'zod';
import { client, parseResponse } from '../lib/api.js';
import type { PrivateRoomSession } from './room-manager.js';

/** The §24.2 import modes, surfaced for the wizard's scope picker. */
export type { MigrationImportMode };

/**
 * Phase 1/3 — read the OLD server room's exportable content (steward-only,
 * server-enforced).  The response is the `MigrationSourceItem` shape the
 * re-author step feeds to `planMigration`.
 */
export async function fetchMigrationExport(roomId: string): Promise<MigrationExportResponse> {
  const response = await client.v1.rooms[':roomId'].migration.export.$post({
    param: { roomId },
  });
  return parseResponse(response, migrationExportResponseSchema);
}

export interface ReauthorResult {
  /** The number of stories authored into the destination P2P room. */
  readonly stories: number;
  /** The number of contributions authored into the destination P2P room. */
  readonly contributions: number;
  /** The honest §24.2 leakage disclosure for the chosen mode (from the SSOT). */
  readonly disclosure: string;
}

/**
 * Phase 3 — plan the import for `mode` over the exported items, then re-author
 * the chosen scope into `session` (the destination P2P room).  `selectedIds` is
 * required for `selected`.  Stories are authored first (so a comment's thread
 * exists) — each story maps its server thread ref to the new P2P thread id, and
 * its contributions are authored against that thread.  `planMigration` decides
 * WHAT (and whether bodies are carried — fresh/redacted strip them); this maps
 * the plan onto `postStory`/`postComment`, which encrypt.
 */
export async function reauthorIntoPrivateRoom(params: {
  readonly session: PrivateRoomSession;
  readonly export: MigrationExportResponse;
  readonly mode: MigrationImportMode;
  readonly selectedIds?: readonly string[];
}): Promise<ReauthorResult> {
  // DYNAMIC import — `planMigration` is a value from the code-split crypto/protocol
  // package; a static import would pull the core into the initial bundle and trip
  // `check:private-p2p-split`.
  const { planMigration } = await import('@licio/private-p2p');
  const plan = planMigration({
    mode: params.mode,
    items: params.export.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      ...(item.title !== undefined ? { title: item.title } : {}),
      ...(item.summary !== undefined ? { summary: item.summary } : {}),
      ...(item.body !== undefined ? { body: item.body } : {}),
      ...(item.threadRef !== undefined ? { threadRef: item.threadRef } : {}),
      ...(item.parentRef !== undefined ? { parentRef: item.parentRef } : {}),
    })),
    ...(params.selectedIds !== undefined ? { selectedIds: params.selectedIds } : {}),
  });

  // Author stories first so each story's NEW P2P thread id exists before its
  // comments are authored.  Map the OLD server thread ref → the new thread id.
  const threadRemap = new Map<string, string>();
  let stories = 0;
  let contributions = 0;
  for (const item of plan.items) {
    if (item.kind !== 'story') continue;
    const title = item.title ?? item.summary ?? '(untitled)';
    const newThreadId = globalThis.crypto.randomUUID();
    await params.session.postStory({ title, threadId: newThreadId });
    if (item.threadRef !== undefined) threadRemap.set(item.threadRef, newThreadId);
    stories += 1;
  }
  // Then contributions, into the remapped thread.  Redacted/fresh plans carry no
  // bodies, so a body-less contribution is skipped (nothing to re-author).
  for (const item of plan.items) {
    if (item.kind !== 'contribution') continue;
    if (item.body === undefined || item.body.length === 0) continue;
    if (item.threadRef === undefined) continue;
    const threadId = threadRemap.get(item.threadRef);
    if (threadId === undefined) continue;
    await params.session.postComment({ threadId, body: item.body });
    contributions += 1;
  }
  return { stories, contributions, disclosure: plan.disclosure };
}

/** Phase 5 — freeze the OLD server room READ-ONLY (server-enforced). */
export async function freezeMigratedRoom(
  roomId: string,
  migratedToRoomId: string,
): Promise<z.infer<typeof migrationFreezeResponseSchema>> {
  const response = await client.v1.rooms[':roomId'].migration.freeze.$post({
    param: { roomId },
    json: { migrated_to_room_id: migratedToRoomId },
  });
  return parseResponse(response, migrationFreezeResponseSchema);
}

/** Phase 6 — purge / minimize the OLD server content (server-enforced; gated on
 *  the room already being frozen). */
export async function purgeMigratedRoom(
  roomId: string,
  mode: 'purge' | 'anonymize',
): Promise<z.infer<typeof migrationPurgeResponseSchema>> {
  const response = await client.v1.rooms[':roomId'].migration.purge.$post({
    param: { roomId },
    json: { mode },
  });
  return parseResponse(response, migrationPurgeResponseSchema);
}
