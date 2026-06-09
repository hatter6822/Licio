// SPDX-License-Identifier: AGPL-3.0-or-later
//
// localStorage-backed persistence for the return tracker (WS-C.4.3 cross-session
// state). State is LOCAL ONLY — never uploaded — and validated through zod on
// every read (corrupt/oversized data is discarded, falling back to empty). Writes
// are best-effort (a quota error never throws into signal collection).
import { z } from 'zod';
import { loadPersisted, savePersisted } from '../stores/persist.js';
import type { ReturnSnapshot, ReturnTrackerStore } from './return-tracker.js';

const snapshotSchema = z.object({
  id: z.string().min(1).max(200),
  lastVisitAt: z.number().finite(),
  returnCount: z.number().int().nonnegative(),
  // Pruned to the rage window on write; the cap defends against corrupt input.
  returnTimes: z.array(z.number().finite()).max(64),
  // Back-compatible: snapshots written before forfeit-tracking default to 0.
  forfeited: z.number().int().nonnegative().default(0),
}) satisfies z.ZodType<ReturnSnapshot>;

// Generous ceiling; the tracker itself caps live entries to its `maxItems`.
const stateSchema = z.array(snapshotSchema).max(2_000);

const PERSIST_CONFIG = {
  key: 'signal-returns',
  schema: stateSchema,
  version: 1,
} as const;

/** A return-tracker store backed by validated, versioned localStorage. */
export function createReturnStore(): ReturnTrackerStore {
  return {
    load: () => loadPersisted(PERSIST_CONFIG) ?? null,
    save: (snapshots) => savePersisted(PERSIST_CONFIG, snapshots),
  };
}
