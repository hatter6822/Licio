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
  type RawEntry,
  rawClear,
  rawCount,
  rawDelete,
  rawDeleteIf,
  rawGet,
  rawGetAllByIndexWithKeys,
  rawGetAllWithKeys,
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
 * exists.  `evict` (server-refetchable snapshot caches) deletes it so the next
 * online read repopulates it and it can never become an immortal record the GC
 * sweep cannot see.  Every read path knows the record's TRUE primary key (a
 * keyed `get` was issued for it; scans pair values with `getAllKeys`), so even
 * a record whose key field is corrupted is removable — and the delete is
 * CONDITIONAL inside one readwrite transaction (`rawDeleteIf`), so a fresh
 * valid record written concurrently (another tab's write-through refresh)
 * between the read and the eviction is never clobbered.
 */
type InvalidReadPolicy = { mode: 'quarantine' } | { mode: 'evict' };

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

  const evict = async (key: IDBValidKey): Promise<void> => {
    if (policy.mode !== 'evict') return;
    try {
      // Atomic re-check: delete ONLY if the value at the key is STILL invalid.
      await rawDeleteIf(storeName, key, (current) => !schema.safeParse(current).success);
    } catch {
      // Best-effort: the record is already excluded from results either way.
    }
  };

  /** Validate one raw record; on failure count + log it and, under the evict
   *  policy, conditionally delete it by its true primary key. */
  const validateRead = async (raw: unknown, key: IDBValidKey): Promise<T | null> => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    recordRejection();
    await evict(key);
    return null;
  };

  const validateScan = async (entries: RawEntry<unknown>[]): Promise<T[]> => {
    const records: T[] = [];
    for (const entry of entries) {
      const record = await validateRead(entry.value, entry.key);
      if (record !== null) records.push(record);
    }
    return records;
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
      return validateScan(await rawGetAllWithKeys<unknown>(storeName));
    },
    async getAllByIndex(index, query) {
      return validateScan(await rawGetAllByIndexWithKeys<unknown>(storeName, index, query));
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
  { mode: 'evict' },
);
export const storyComments: IntegrityStore<StoryCommentsSnapshotRecord> = createStore(
  STORE.storyComments,
  storyCommentsSnapshotRecordSchema,
  { mode: 'evict' },
);
export const signalLedger: IntegrityStore<SignalLedgerRecord> = createStore(
  STORE.signalLedger,
  signalLedgerRecordSchema,
  { mode: 'evict' },
);
