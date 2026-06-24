// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — server→private migration planning (PRIVATE_SPEC §24).  A Members-only
// server room is NEVER upgraded in place: migration creates a NEW P2P room and the
// owner optionally re-imports history THROUGH A MEMBER'S CLIENT.  This pure core
// decides, for a chosen §24.2 import mode, WHICH server items become P2P ops and how
// they are redacted — the client then authors them via `buildRoomOp` and the §24.3
// warning is shown before any import.  It carries the honest disclosure from the shared
// SSOT so the wizard and the docs share one wording (pinned by the copy-lint).
//
// Doctrine: migration cannot make past server access impossible (the imported history
// was already server-hosted).  `carriesPlaintextBodies` makes that explicit per plan so
// the UI can surface the §24.3 disclosure with the right emphasis.

import { PRIVATE_ROOM_IMPORT_MODES, type PrivateRoomImportModeId } from '@licio/shared';

/** A historical item read from the old server room (the migration source). */
export interface MigrationSourceItem {
  readonly id: string;
  readonly kind: 'story' | 'contribution';
  readonly title?: string;
  readonly summary?: string;
  readonly body?: string;
  /** The thread/story this belongs to (preserved so the P2P DAG mirrors structure). */
  readonly threadRef?: string;
  readonly parentRef?: string;
}

/** A planned P2P item to author — `body` is stripped for the redacted mode. */
export interface MigrationPlanItem {
  readonly id: string;
  readonly kind: 'story' | 'contribution';
  readonly title?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly threadRef?: string;
  readonly parentRef?: string;
}

export interface MigrationPlan {
  readonly mode: PrivateRoomImportModeId;
  readonly items: readonly MigrationPlanItem[];
  /** The honest §24.2 leakage disclosure for this mode (from the shared SSOT). */
  readonly disclosure: string;
  /** Whether the plan re-encrypts plaintext bodies (false for fresh + redacted). */
  readonly carriesPlaintextBodies: boolean;
}

export interface PlanMigrationParams {
  readonly mode: PrivateRoomImportModeId;
  readonly items: readonly MigrationSourceItem[];
  /** Required for `selected`: the ids the user chose to import. */
  readonly selectedIds?: readonly string[];
}

function disclosureFor(mode: PrivateRoomImportModeId): string {
  const found = PRIVATE_ROOM_IMPORT_MODES.find((m) => m.id === mode);
  if (!found) throw new RangeError(`planMigration: unknown import mode ${mode}`);
  return found.disclosure;
}

/** Strip an item to titles/summaries only (the §24.2 redacted mode). */
function redact(item: MigrationSourceItem): MigrationPlanItem {
  const out: MigrationPlanItem = { id: item.id, kind: item.kind };
  return {
    ...out,
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.summary !== undefined ? { summary: item.summary } : {}),
    ...(item.threadRef !== undefined ? { threadRef: item.threadRef } : {}),
    ...(item.parentRef !== undefined ? { parentRef: item.parentRef } : {}),
    // body intentionally dropped
  };
}

/**
 * Plan a §24.2 migration import.  Pure + deterministic:
 *   - `fresh`    → nothing imported (best privacy going forward);
 *   - `selected` → only the user-chosen ids, full content;
 *   - `full`     → every item, full content;
 *   - `redacted` → every item, titles/summaries only (bodies stripped).
 * Returns the items to re-author + the honest disclosure + whether plaintext bodies are
 * carried.  Input order is preserved (the client authors causally over it).
 */
export function planMigration(params: PlanMigrationParams): MigrationPlan {
  const disclosure = disclosureFor(params.mode);
  switch (params.mode) {
    case 'fresh':
      return { mode: 'fresh', items: [], disclosure, carriesPlaintextBodies: false };
    case 'full':
      return {
        mode: 'full',
        items: params.items.map((i) => ({ ...i })),
        disclosure,
        carriesPlaintextBodies: true,
      };
    case 'selected': {
      const chosen = new Set(params.selectedIds ?? []);
      // The wizard selects STORY ids, but a selected story carries its whole conversation: also
      // include every contribution whose `threadRef` is a selected story's thread.  Without this a
      // selected thread migrates as a story SHELL with its comments silently dropped (§24 history
      // loss).  A contribution may also be chosen directly (defensive — supports future
      // contribution-level selection).
      const selectedStoryThreads = new Set(
        params.items
          .filter((i) => i.kind === 'story' && chosen.has(i.id) && i.threadRef !== undefined)
          .map((i) => i.threadRef as string),
      );
      return {
        mode: 'selected',
        items: params.items
          .filter(
            (i) =>
              chosen.has(i.id) ||
              (i.kind === 'contribution' &&
                i.threadRef !== undefined &&
                selectedStoryThreads.has(i.threadRef)),
          )
          .map((i) => ({ ...i })),
        disclosure,
        carriesPlaintextBodies: true,
      };
    }
    case 'redacted':
      return {
        mode: 'redacted',
        items: params.items.map(redact),
        disclosure,
        carriesPlaintextBodies: false,
      };
  }
}
