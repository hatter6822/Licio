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
//      ENCRYPTS as it authors — the server never sees the re-encrypted content).
//      Re-authoring is IDEMPOTENT under retry/resume (§24 is a one-shot
//      destructive flow that ends in freeze+purge, so a transient mid-loop
//      failure must NOT double-author the prefix on retry): each source story
//      maps to a DETERMINISTIC P2P thread id (so a re-run lands on the same
//      thread, which the reducer already holds → skipped), and every authored
//      source-item id is recorded in a persisted manifest, so a resumed run
//      continues from where it stopped rather than duplicating;
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
import {
  readAuthoredItems,
  recordAuthoredItems,
} from '../components/migration/MigrationWizard/migration-progress.js';
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
  /** The number of stories newly authored into the destination P2P room. */
  readonly stories: number;
  /** The number of contributions newly authored into the destination P2P room. */
  readonly contributions: number;
  /** Items skipped because a prior run already authored them (idempotent resume). */
  readonly skipped: number;
  /** The honest §24.2 leakage disclosure for the chosen mode (from the SSOT). */
  readonly disclosure: string;
}

/**
 * Derive a STABLE P2P thread id for a source story, scoped to the destination
 * room, so a re-run of the same migration re-authors the SAME thread (which the
 * reducer already holds → the engine no-ops / the caller skips it) rather than
 * minting a fresh duplicate.  RFC 4122 v5-style: SHA-256 over a namespace
 * (`destinationRoomId`) + the source id, formatted as a v4-shaped UUID.  Pure
 * (no `crypto.randomUUID`), so it is deterministic across attempts.
 */
/** A deterministic v4-shaped UUID from a namespaced key — so a re-run (after a crash, manifest
 *  lost) reproduces the SAME id, which lets the live reduced state act as the idempotency SSOT
 *  AND lets a reply remap its parent to the parent's stable new id without a persisted map. */
async function deterministicUuid(...parts: readonly string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join(':'));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  // Take the first 16 bytes and force the version (4) + variant (8/9/a/b) nibbles
  // so the result is a structurally valid v4-shaped UUID the schema layer accepts.
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  let h = '';
  for (const byte of bytes) h += byte.toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const deterministicThreadId = (destinationRoomId: string, sourceStoryId: string): Promise<string> =>
  deterministicUuid('licio-migrate-thread', destinationRoomId, sourceStoryId);

const deterministicContributionId = (
  destinationRoomId: string,
  sourceContributionId: string,
): Promise<string> =>
  deterministicUuid('licio-migrate-contribution', destinationRoomId, sourceContributionId);

/**
 * Phase 3 — plan the import for `mode` over the exported items, then re-author
 * the chosen scope into `session` (the destination P2P room).  `selectedIds` is
 * required for `selected`.  Stories are authored first (so a comment's thread
 * exists) — each story maps its server thread ref to a DETERMINISTIC new P2P
 * thread id, and its contributions are authored against that thread.
 * `planMigration` decides WHAT (and whether bodies are carried — fresh/redacted
 * strip them); this maps the plan onto `postStory`/`postComment`, which encrypt.
 *
 * IDEMPOTENT: a story whose deterministic thread already exists in the reduced
 * state is skipped, and every source-item id authored in a prior run (persisted
 * manifest) is skipped — so a retry after a mid-loop failure CONVERGES to one
 * copy of each item rather than duplicating the already-authored prefix.
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

  const destinationRoomId = params.session.roomId;
  // The persisted manifest of source-item ids already authored in a PRIOR run of
  // this migration (survives a reload); seeds the "already done" skip set. Each
  // newly-authored item is flushed back to the manifest AS IT LANDS (incremental
  // `recordAuthoredItems`), so a crash mid-run still records the completed prefix.
  const alreadyAuthored = new Set(readAuthoredItems(destinationRoomId));
  // The live reducer threads, so a re-run that lost its manifest still skips a
  // story whose deterministic thread is already present (state is the SSOT).
  const existingThreads = new Set(params.session.state().threads.keys());

  let stories = 0;
  let contributions = 0;
  let skipped = 0;

  // Author stories first so each story's NEW (deterministic) P2P thread id exists
  // before its comments are authored.  Map the OLD server thread ref → that id.
  const threadRemap = new Map<string, string>();
  for (const item of plan.items) {
    if (item.kind !== 'story') continue;
    const title = item.title ?? item.summary ?? '(untitled)';
    const newThreadId = await deterministicThreadId(destinationRoomId, item.id);
    if (item.threadRef !== undefined) threadRemap.set(item.threadRef, newThreadId);
    // Idempotent skip: the manifest OR the live reduced state already holds it.
    if (alreadyAuthored.has(item.id) || existingThreads.has(newThreadId)) {
      skipped += 1;
      continue;
    }
    await params.session.postStory({ title, threadId: newThreadId });
    recordAuthoredItems(destinationRoomId, [item.id]);
    stories += 1;
  }

  // Then contributions, into the remapped thread.  Redacted/fresh plans carry no
  // bodies, so a body-less contribution is skipped (nothing to re-author).
  //
  // Preserve the §13.5 reply structure: map each source contribution id → its DETERMINISTIC
  // new id, and re-author each reply UNDER its remapped parent (the export lists contributions
  // in CAUSAL order, so a parent precedes its replies and already exists in reduced state when
  // the reply lands).  A reply lands top-level only if its parent is not among the migrated
  // (body-carrying) set — never a dangling parent ref.
  const contribRemap = new Map<string, string>();
  const willAuthor = new Set<string>();
  for (const item of plan.items) {
    if (item.kind !== 'contribution') continue;
    contribRemap.set(item.id, await deterministicContributionId(destinationRoomId, item.id));
    if (item.body !== undefined && item.body.length > 0) willAuthor.add(item.id);
  }
  for (const item of plan.items) {
    if (item.kind !== 'contribution') continue;
    if (item.body === undefined || item.body.length === 0) continue;
    if (item.threadRef === undefined) continue;
    const threadId = threadRemap.get(item.threadRef);
    if (threadId === undefined) continue;
    if (alreadyAuthored.has(item.id)) {
      skipped += 1;
      continue;
    }
    const contributionId = contribRemap.get(item.id);
    const parentContributionId =
      item.parentRef !== undefined && willAuthor.has(item.parentRef)
        ? contribRemap.get(item.parentRef)
        : undefined;
    await params.session.postComment({
      threadId,
      body: item.body,
      ...(contributionId !== undefined ? { contributionId } : {}),
      ...(parentContributionId !== undefined ? { parentContributionId } : {}),
    });
    recordAuthoredItems(destinationRoomId, [item.id]);
    contributions += 1;
  }

  return { stories, contributions, skipped, disclosure: plan.disclosure };
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
