// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data-integrity layer over IndexedDB (WS-C.2.2c, SPEC §6.9/§6.12.7). Every read
// is validated through a zod schema before it reaches application state, and
// every write is validated before it is stored. A record that fails read
// validation is counted, logged, and EXCLUDED from results; what happens to it
// then is a per-store policy. USER DATA (saves, drafts) is QUARANTINED — left in
// place so a recovery path exists (never silently deleted). Server-refetchable
// SNAPSHOT CACHES are EVICTED — the server copy is authoritative, so there is
// nothing to recover, and a quarantined cache record would otherwise be immortal:
// the GC sweep reads through this validating layer, so an invalid record never
// appears in the sweep's results and can never age out, re-logging (and
// re-counting) on every read until a same-key write-through overwrites it.
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

/**
 * What happens to a record that fails read validation, after it is counted and
 * logged.  `quarantine` (user data) leaves it in place so a recovery path
 * exists.  `evict` (server-refetchable snapshot caches) deletes it best-effort
 * by its primary key — `keyPath` names the store's keyPath property — so the
 * next online read repopulates it and it can never become an immortal record
 * the GC sweep cannot see.
 */
type InvalidReadPolicy = { mode: 'quarantine' } | { mode: 'evict'; keyPath: string };

function createStore<T>(
  storeName: StoreName,
  schema: z.ZodType<T>,
  policy: InvalidReadPolicy,
): IntegrityStore<T> {
  const recordRejection = (): void => {
    rejectionCounts.set(storeName, (rejectionCounts.get(storeName) ?? 0) + 1);
    if (IS_DEV) {
      const verb = policy.mode === 'evict' ? 'evicted' : 'quarantined';
      console.warn(`[offline] ${verb} an invalid ${storeName} record`);
    }
  };

  // The invalid record's primary key, read from the raw value (untrusted, so
  // only a non-empty string is accepted — every store here has a string keyPath).
  const keyOf = (raw: unknown): IDBValidKey | undefined => {
    if (policy.mode !== 'evict' || typeof raw !== 'object' || raw === null) return undefined;
    const key = (raw as Record<string, unknown>)[policy.keyPath];
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  };

  const evict = async (key: IDBValidKey | undefined): Promise<void> => {
    if (policy.mode !== 'evict' || key === undefined) return;
    try {
      await rawDelete(storeName, key);
    } catch {
      // Best-effort: the record is already excluded from results either way.
    }
  };

  /** Validate one raw record; on failure count + log it and, under the evict
   *  policy, delete it (`knownKey` — the key a keyed `get` was issued for —
   *  beats extraction, so even a record with a corrupt keyPath field is removable). */
  const validateRead = async (raw: unknown, knownKey?: IDBValidKey): Promise<T | null> => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    recordRejection();
    await evict(knownKey ?? keyOf(raw));
    return null;
  };

  return {
    async put(record) {
      await rawPut(storeName, schema.parse(record));
    },
    async get(key) {
      const raw = await rawGet<unknown>(storeName, key);
      if (raw === undefined) return undefined;
      return (await validateRead(raw, key)) ?? undefined;
    },
    async getAll() {
      const raws = await rawGetAll<unknown>(storeName);
      const records: T[] = [];
      for (const raw of raws) {
        const record = await validateRead(raw);
        if (record !== null) records.push(record);
      }
      return records;
    },
    async getAllByIndex(index, query) {
      const raws = await rawGetAllByIndex<unknown>(storeName, index, query);
      const records: T[] = [];
      for (const raw of raws) {
        const record = await validateRead(raw);
        if (record !== null) records.push(record);
      }
      return records;
    },
    delete: (key) => rawDelete(storeName, key),
    clear: () => rawClear(storeName),
    count: () => rawCount(storeName),
  };
}

// USER DATA — quarantined in place on read failure (a recovery path must exist).
export const savedStories: IntegrityStore<SavedStoryRecord> = createStore(
  STORE.savedStories,
  savedStoryRecordSchema,
  { mode: 'quarantine' },
);
export const draftContributions: IntegrityStore<DraftContributionRecord> = createStore(
  STORE.draftContributions,
  draftContributionRecordSchema,
  { mode: 'quarantine' },
);
export const draftStories: IntegrityStore<DraftStoryRecord> = createStore(
  STORE.draftStories,
  draftStoryRecordSchema,
  { mode: 'quarantine' },
);
// SERVER-REFETCHABLE SNAPSHOT CACHES — evicted on read failure (the server copy
// is authoritative; the next online read-through repopulates the record).
export const threadSnapshots: IntegrityStore<ThreadSnapshotRecord> = createStore(
  STORE.threadSnapshots,
  threadSnapshotRecordSchema,
  { mode: 'evict', keyPath: 'threadId' },
);
export const storyComments: IntegrityStore<StoryCommentsSnapshotRecord> = createStore(
  STORE.storyComments,
  storyCommentsSnapshotRecordSchema,
  { mode: 'evict', keyPath: 'cacheKey' },
);
export const signalLedger: IntegrityStore<SignalLedgerRecord> = createStore(
  STORE.signalLedger,
  signalLedgerRecordSchema,
  { mode: 'evict', keyPath: 'itemId' },
);
