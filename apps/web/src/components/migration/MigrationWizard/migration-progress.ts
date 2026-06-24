// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — migration RESUMABILITY + idempotency progress (PRIVATE_SPEC §24).
//
// The §24 migration is a 6-phase flow with IRREVERSIBLE server-side side effects
// (phase 5 freezes the OLD room read-only; phase 6 purges its content) and a
// CLIENT-LOCAL destination (the new Private P2P room lives only in this device's
// IndexedDB — it has no server row).  A page reload mid-flow must therefore
// RESUME rather than strand the freshly-created P2P room and re-run the
// destructive steps.  This module persists, in zod-validated localStorage:
//
//   • the WIZARD progress per SOURCE room (which phase, the created destination
//     roomId, the chosen import mode, the disclosure ack) so a reload re-opens
//     the existing destination and continues from the recorded phase; and
//   • the AUTHORED-ITEMS manifest per DESTINATION room (the set of source-item
//     ids already re-authored) so a re-author retry after a mid-loop failure
//     SKIPS the already-authored prefix instead of duplicating it.
//
// Writes are best-effort (a quota error never throws into the flow); reads are
// schema-validated (a corrupt value is discarded → the wizard starts clean).
// The progress carries NO UGC — only ids, the phase index, and the mode.

import { z } from 'zod';
import { clearPersisted, loadPersisted, savePersisted } from '../../../stores/persist.js';

/** The persisted migration phase (0–5, mirrors the wizard's `Phase`). */
const phaseSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

/** Per-source-room wizard progress (resumability SSOT). */
export const migrationProgressSchema = z.object({
  /** The OLD Members-only server room being migrated (the resume key). */
  sourceRoomId: z.string().min(1),
  /** The current wizard phase (0-indexed). */
  phase: phaseSchema,
  /** The created destination P2P room id, or null before phase 2 completes. */
  destinationRoomId: z.string().min(1).nullable(),
  /** The chosen §24.2 import mode (defaults `fresh`). */
  mode: z.enum(['fresh', 'selected', 'full', 'redacted']),
  /** The chosen phase-6 minimization. */
  purgeMode: z.enum(['purge', 'anonymize']),
  /** Whether the §24.3 blocking disclosure was acknowledged. */
  acked: z.boolean(),
});
export type MigrationProgress = z.infer<typeof migrationProgressSchema>;

const PROGRESS_VERSION = 1;
const MANIFEST_VERSION = 1;

/** localStorage key for a source room's wizard progress. */
function progressKey(sourceRoomId: string): string {
  return `migration:progress:${sourceRoomId}`;
}

/** localStorage key for a destination room's authored-items manifest. */
function manifestKey(destinationRoomId: string): string {
  return `migration:authored:${destinationRoomId}`;
}

/** Read the persisted wizard progress for a source room (undefined if none/invalid). */
export function loadMigrationProgress(sourceRoomId: string): MigrationProgress | undefined {
  const progress = loadPersisted({
    key: progressKey(sourceRoomId),
    schema: migrationProgressSchema,
    version: PROGRESS_VERSION,
  });
  // Guard against a key collision / hand-edited value: the resume key must match.
  if (progress !== undefined && progress.sourceRoomId !== sourceRoomId) return undefined;
  return progress;
}

/** Persist (or update) the wizard progress for a source room. */
export function saveMigrationProgress(progress: MigrationProgress): void {
  savePersisted(
    {
      key: progressKey(progress.sourceRoomId),
      schema: migrationProgressSchema,
      version: PROGRESS_VERSION,
    },
    progress,
  );
}

/** Clear the persisted wizard progress + authored manifest once the migration
 *  completes (so a future migration of the same room starts clean). */
export function clearMigrationProgress(sourceRoomId: string, destinationRoomId?: string): void {
  clearPersisted(progressKey(sourceRoomId));
  if (destinationRoomId !== undefined) clearPersisted(manifestKey(destinationRoomId));
}

const manifestArraySchema = z.array(z.string().min(1).max(128));

/** Read the set of source-item ids already authored into a destination room. */
export function readAuthoredItems(destinationRoomId: string): readonly string[] {
  return (
    loadPersisted({
      key: manifestKey(destinationRoomId),
      schema: manifestArraySchema,
      version: MANIFEST_VERSION,
    }) ?? []
  );
}

/**
 * Record source-item ids as authored (idempotent: union with the existing set).
 * Called incrementally as each item lands, so a crash mid-run still persists the
 * completed prefix and a resumed run skips it.
 */
export function recordAuthoredItems(destinationRoomId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const merged = new Set(readAuthoredItems(destinationRoomId));
  for (const id of ids) merged.add(id);
  savePersisted(
    { key: manifestKey(destinationRoomId), schema: manifestArraySchema, version: MANIFEST_VERSION },
    [...merged],
  );
}
