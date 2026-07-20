// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data-integrity layer over IndexedDB (WS-C.2.2c, SPEC §6.9/§6.12.7). Every read
// is validated through a zod schema before it reaches application state, and
// every write is validated before it is stored. A record that fails read
// validation is QUARANTINED — counted, logged, and EXCLUDED from results, but
// left in place so a recovery path exists (never silently deleted).
import type { z } from 'zod';
import {
  rawClear,
  rawCount,
  rawDelete,
  rawGet,
  rawGetAll,
  rawGetAllByIndex,
  rawPut,
  STORE,
  type StoreName,
} from './db.js';
import {
  type DraftContributionRecord,
  type DraftStoryRecord,
  draftContributionRecordSchema,
  draftStoryRecordSchema,
  type SavedStoryRecord,
  type SignalLedgerRecord,
  type StoryCommentsSnapshotRecord,
  savedStoryRecordSchema,
  signalLedgerRecordSchema,
  storyCommentsSnapshotRecordSchema,
  type ThreadSnapshotRecord,
  threadSnapshotRecordSchema,
} from './schemas.js';

const IS_DEV = import.meta.env.DEV === true;

// Per-store read-validation rejection counts (observability, WS-C.2.2c — a spike
// signals a bad migration or tampering and should alert).
const rejectionCounts = new Map<string, number>();
// The last value reported to the telemetry sink per store, so drainRejectionDeltas
// can emit only the NEW rejections since the previous report (delta semantics —
// exactly one quarantine event per new rejection, never a re-report of the total).
const lastReported = new Map<string, number>();
export function getRejectionCount(store: StoreName): number {
  return rejectionCounts.get(store) ?? 0;
}
export function resetRejectionCounts(): void {
  rejectionCounts.clear();
  lastReported.clear();
}

/**
 * Drain the per-store rejection counters into positive deltas since the last
 * drain, advancing the reported watermark. Returns one entry per store whose
 * rejection count grew, so the observability layer can emit a single telemetry
 * event per new quarantine (WS-C.2.2c — a spike signals a bad migration or
 * tampering and should alert).
 */
export function drainRejectionDeltas(): Array<{ store: StoreName; count: number }> {
  const deltas: Array<{ store: StoreName; count: number }> = [];
  for (const [store, current] of rejectionCounts) {
    const delta = current - (lastReported.get(store) ?? 0);
    if (delta > 0) {
      lastReported.set(store, current);
      deltas.push({ store: store as StoreName, count: delta });
    }
  }
  return deltas;
}

export interface IntegrityStore<T> {
  /** Validate then write. Throws on an invalid record (write validation). */
  put(record: T): Promise<void>;
  /** Read one; returns undefined if missing or quarantined (invalid). */
  get(key: IDBValidKey): Promise<T | undefined>;
  /** Read all valid records; invalid ones are quarantined and excluded. */
  getAll(): Promise<T[]>;
  /** Read valid records via an index. */
  getAllByIndex(index: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]>;
  delete(key: IDBValidKey): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

function createStore<T>(storeName: StoreName, schema: z.ZodType<T>): IntegrityStore<T> {
  const validateRead = (raw: unknown): T | null => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    rejectionCounts.set(storeName, (rejectionCounts.get(storeName) ?? 0) + 1);
    if (IS_DEV) console.warn(`[offline] quarantined an invalid ${storeName} record`);
    return null;
  };
  const keep = (record: T | null): record is T => record !== null;

  return {
    async put(record) {
      await rawPut(storeName, schema.parse(record));
    },
    async get(key) {
      const raw = await rawGet<unknown>(storeName, key);
      if (raw === undefined) return undefined;
      return validateRead(raw) ?? undefined;
    },
    async getAll() {
      const raws = await rawGetAll<unknown>(storeName);
      return raws.map(validateRead).filter(keep);
    },
    async getAllByIndex(index, query) {
      const raws = await rawGetAllByIndex<unknown>(storeName, index, query);
      return raws.map(validateRead).filter(keep);
    },
    delete: (key) => rawDelete(storeName, key),
    clear: () => rawClear(storeName),
    count: () => rawCount(storeName),
  };
}

export const savedStories: IntegrityStore<SavedStoryRecord> = createStore(
  STORE.savedStories,
  savedStoryRecordSchema,
);
export const draftContributions: IntegrityStore<DraftContributionRecord> = createStore(
  STORE.draftContributions,
  draftContributionRecordSchema,
);
export const draftStories: IntegrityStore<DraftStoryRecord> = createStore(
  STORE.draftStories,
  draftStoryRecordSchema,
);
export const threadSnapshots: IntegrityStore<ThreadSnapshotRecord> = createStore(
  STORE.threadSnapshots,
  threadSnapshotRecordSchema,
);
export const storyComments: IntegrityStore<StoryCommentsSnapshotRecord> = createStore(
  STORE.storyComments,
  storyCommentsSnapshotRecordSchema,
);
export const signalLedger: IntegrityStore<SignalLedgerRecord> = createStore(
  STORE.signalLedger,
  signalLedgerRecordSchema,
);
