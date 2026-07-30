// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Offline read-through cache (WS-C.2.2a, SPEC §6.9). Write-through on a successful
// network read, read-back when the network is unavailable. Every mapping crosses
// the zod-validated integrity layer (store.ts), and EVERY operation here is
// best-effort: a missing/*full* IndexedDB never throws into the read path, so
// caching can only ever HELP — the network result is returned regardless. The
// orchestration that prefers network then falls back to cache lives in the query
// layer (lib/queries.ts); this module is the pure cache mapping.
import type {
  SignalLedgerEntry,
  StoryCommentsResponse,
  StoryDetail,
  ThreadDetail,
} from '@licio/shared';
import type {
  SavedStoryRecord,
  SignalLedgerRecord,
  StoryCommentsSnapshotRecord,
  ThreadSnapshotRecord,
} from './schemas.js';
import { RECORD_SCHEMA_VERSION } from './schemas.js';
import {
  type IntegrityStore,
  savedStories,
  signalLedger,
  storyComments,
  threadSnapshots,
} from './store.js';

/** Run a storage side-effect, swallowing any error (offline storage is best-effort). */
async function bestEffort(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch {
    // IndexedDB absent, quota exceeded, or evicted — non-fatal for the read path.
  }
}

// --- Signal Ledger (private) ----------------------------------------------
// The load-bearing fields — the buckets + flags — round-trip EXACTLY; only
// `recorded_at` is normalized (ISO → epoch ms → ISO), i.e. coerced to UTC at
// millisecond precision. Acceptable for a private, read-only ledger snapshot.

function entryToLedgerRecord(entry: SignalLedgerEntry): SignalLedgerRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    itemId: entry.item_id,
    storyTitle: entry.story_title,
    recordedAt: Date.parse(entry.recorded_at),
    activeDwellBucket: entry.active_dwell_bucket,
    sourceOpened: entry.source_opened,
    contextOpened: entry.context_opened,
    replyDepthBucket: entry.reply_depth_bucket,
    returnVisitCountBucket: entry.return_visit_count_bucket,
    ...(entry.saved_for_later !== undefined ? { savedForLater: entry.saved_for_later } : {}),
    ...(entry.anti_signals !== undefined ? { antiSignals: entry.anti_signals } : {}),
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    ...(entry.cap_reached !== undefined ? { capReached: entry.cap_reached } : {}),
  };
}

function ledgerRecordToEntry(record: SignalLedgerRecord): SignalLedgerEntry {
  return {
    item_id: record.itemId,
    story_title: record.storyTitle,
    recorded_at: new Date(record.recordedAt).toISOString(),
    active_dwell_bucket: record.activeDwellBucket,
    source_opened: record.sourceOpened,
    context_opened: record.contextOpened,
    reply_depth_bucket: record.replyDepthBucket,
    return_visit_count_bucket: record.returnVisitCountBucket,
    ...(record.savedForLater !== undefined ? { saved_for_later: record.savedForLater } : {}),
    ...(record.antiSignals !== undefined ? { anti_signals: record.antiSignals } : {}),
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
    ...(record.capReached !== undefined ? { cap_reached: record.capReached } : {}),
  };
}

/** Replace the cached Signal Ledger snapshot with the latest entries. */
export async function cacheSignalLedger(entries: SignalLedgerEntry[]): Promise<void> {
  await bestEffort(async () => {
    await signalLedger.clear();
    for (const entry of entries) {
      await signalLedger.put(entryToLedgerRecord(entry));
    }
  });
}

/** Read the cached Signal Ledger (most-recent first); empty when unavailable. */
export async function readCachedSignalLedger(): Promise<SignalLedgerEntry[]> {
  try {
    const records = await signalLedger.getAll();
    return records.sort((a, b) => b.recordedAt - a.recordedAt).map(ledgerRecordToEntry);
  } catch {
    return [];
  }
}

// --- Snapshot count budgets (the OTHER growth bound) -----------------------

/**
 * Age is not a bound on its own. `cacheStoryCommentsSnapshot` keys on
 * `${storyId}:${order,filter,root,depth}`, so a SINGLE story yields a distinct
 * record — each holding the full comment tree — per sort order, per filter, per
 * drill-down root and per depth. A reader opening 100 stories a day and toggling
 * Newest/Oldest accumulates thousands of them well inside the 14-day
 * {@link SNAPSHOT_MAX_AGE_MS} window, and what that pressure buys on a
 * quota-tight origin (iOS Safari reclaims aggressively) is WHOLE-ORIGIN
 * eviction — which takes `draft-contributions`, `draft-stories` and
 * `pending-queue` with it, i.e. the reader's UNSENT writes. `offline/eviction.ts`
 * detects that event; only a cap prevents this cache from causing it.
 *
 * Both stores are server-refetchable convenience mirrors, so a trim costs a
 * network read at worst. The numbers mirror the entry caps the project already
 * applies to its Workbox runtime caches (200 API / 100 image / 10 font).
 */
export const MAX_STORY_COMMENT_SNAPSHOTS = 200;
export const MAX_THREAD_SNAPSHOTS = 200;

/**
 * Hysteresis. Breaching a cap trims back to this FRACTION of it, not to the cap
 * itself: `cacheStoryCommentsSnapshot` is awaited inside the comments `queryFn`
 * (lib/queries.ts), so the trim's scan sits on the render path — and that scan
 * deserializes and zod-validates every cached comment TREE just to learn its
 * key. Trimming to the cap exactly would re-run it on EVERY write once the cache
 * is full; trimming to 90% amortises it over ~10% of the budget's writes.
 */
export const SNAPSHOT_TRIM_RATIO = 0.9;

/**
 * Drop the least-recently-cached records once `store` exceeds `budget`.
 *
 * `getAllByIndex('cachedAt')` returns INDEX order, so the oldest come first —
 * an exact LRU trim needing no new index and no new store. The cheap count guard
 * runs first so an under-budget write never touches the records at all; the trim
 * itself sizes off the returned LIST rather than that count, because a record that
 * failed read validation is excluded from the list but still counted (it is
 * evicted by the scan's own policy, so the next write sees it gone).
 *
 * That guard counts the INDEX, not the store. `count()` counts every record;
 * IndexedDB omits a record from an index when its index key is absent or invalid,
 * so the two measure different populations and the budget stopped meaning what it
 * says the moment they diverged: an index-invisible record was counted against the
 * cap it could never be trimmed from, so the store settled ABOVE budget and every
 * subsequent write re-ran the full scan the 90% trim ratio exists to amortise. The
 * self-healing the paragraph above describes is real, and reaches only records the
 * scan RETURNS — which is precisely not these. `expireOldSnapshots` reaps them.
 */
async function trimToBudget<T>(
  store: IntegrityStore<T>,
  budget: number,
  keyOf: (record: T) => IDBValidKey,
): Promise<void> {
  if ((await store.countByIndex('cachedAt')) <= budget) return;
  const oldestFirst = await store.getAllByIndex('cachedAt');
  const target = Math.floor(budget * SNAPSHOT_TRIM_RATIO);
  const excess = Math.max(0, oldestFirst.length - target);
  for (const record of oldestFirst.slice(0, excess)) {
    await store.delete(keyOf(record));
  }
}

// --- Story comment snapshots (first page, lossy offline fallback) ----------

function stableOptionsKey(options: {
  order?: string;
  filter?: string;
  root?: string;
  depth?: number;
}): string {
  return JSON.stringify({
    order: options.order ?? 'oldest',
    filter: options.filter ?? 'all',
    root: options.root ?? null,
    depth: options.depth ?? 1,
  });
}

function commentCacheKey(
  storyId: string,
  options: { order?: string; filter?: string; root?: string; depth?: number },
): string {
  return `${storyId}:${stableOptionsKey(options)}`;
}

export async function cacheStoryCommentsSnapshot(
  storyId: string,
  options: { order?: string; filter?: string; root?: string; depth?: number },
  response: StoryCommentsResponse,
): Promise<void> {
  const optionsKey = stableOptionsKey(options);
  await bestEffort(async () => {
    await storyComments.put({
      schemaVersion: RECORD_SCHEMA_VERSION,
      cacheKey: commentCacheKey(storyId, options),
      storyId,
      optionsKey,
      comments: response.comments,
      nextCursor: response.next_cursor,
      overview: response.overview,
      cachedAt: Date.now(),
    });
    // Inside the SAME bestEffort as the write, so the trim can never throw into
    // the read path (the write already succeeded either way).
    await trimToBudget(storyComments, MAX_STORY_COMMENT_SNAPSHOTS, (record) => record.cacheKey);
  });
}

export async function readStoryCommentsSnapshot(
  storyId: string,
  options: { order?: string; filter?: string; root?: string; depth?: number } = {},
): Promise<StoryCommentsSnapshotRecord | undefined> {
  try {
    return await storyComments.get(commentCacheKey(storyId, options));
  } catch {
    return undefined;
  }
}

// --- Thread snapshots (title for offline reading) --------------------------

/** Cache a thread's title for offline reading. */
export async function cacheThreadSnapshot(detail: ThreadDetail): Promise<void> {
  await bestEffort(async () => {
    await threadSnapshots.put({
      schemaVersion: RECORD_SCHEMA_VERSION,
      threadId: detail.thread_id,
      title: detail.title,
      cachedAt: Date.now(),
    });
    await trimToBudget(threadSnapshots, MAX_THREAD_SNAPSHOTS, (record) => record.threadId);
  });
}

/** Read a cached thread summary; undefined when missing or unavailable. */
export async function readThreadSnapshot(
  threadId: string,
): Promise<ThreadSnapshotRecord | undefined> {
  try {
    return await threadSnapshots.get(threadId);
  } catch {
    return undefined;
  }
}

// --- Snapshot GC (unbounded-growth control) --------------------------------

/**
 * Snapshot caches are lossy convenience mirrors, not durable user data, so they
 * age out. 14 days keeps recently-read threads/comments available offline while
 * bounding IndexedDB growth. The `cachedAt` index on both stores exists precisely
 * to make this sweep cheap; nothing consumed it before.
 */
export const SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Delete story-comment and thread snapshots older than {@link SNAPSHOT_MAX_AGE_MS}
 * (called on app start, alongside `expireOldDrafts`). Best-effort: a missing or
 * full IndexedDB never throws, mirroring the rest of this module. Each record is
 * removed by its own keyPath value (`cacheKey` / `threadId`), never a synthetic key.
 */
export async function expireOldSnapshots(now: number = Date.now()): Promise<void> {
  await bestEffort(async () => {
    const cutoff = now - SNAPSHOT_MAX_AGE_MS;
    const range = IDBKeyRange.upperBound(cutoff);
    const staleComments = await storyComments.getAllByIndex('cachedAt', range);
    for (const record of staleComments) {
      await storyComments.delete(record.cacheKey);
    }
    const staleThreads = await threadSnapshots.getAllByIndex('cachedAt', range);
    for (const record of staleThreads) {
      await threadSnapshots.delete(record.threadId);
    }
    // A snapshot with no indexable `cachedAt` is invisible to BOTH sweeps above
    // and to the LRU trim, so nothing could ever remove it — it would hold its
    // share of the quota until the whole database was evicted, taking the
    // reader's unsent drafts with it. Both stores are server-refetchable, so the
    // next online read repopulates whatever this drops.
    await storyComments.reapUnindexed('cachedAt');
    await threadSnapshots.reapUnindexed('cachedAt');
  });
}

// --- Saved stories (explicit save for offline reading) --------------------

/** Save a story for offline reading (idempotent; re-saving refreshes savedAt). */
export async function saveStory(story: StoryDetail): Promise<void> {
  await bestEffort(() =>
    savedStories.put({
      schemaVersion: RECORD_SCHEMA_VERSION,
      storyId: story.story_id,
      title: story.title,
      source: story.source,
      url: story.url ?? null,
      // Persist the real room so the savedStories `roomId` index is populated
      // (it was hardcoded null, leaving the index permanently empty).
      roomId: story.room_id ?? null,
      savedAt: Date.now(),
    }),
  );
}

/** Remove a saved story. */
export async function unsaveStory(storyId: string): Promise<void> {
  await bestEffort(() => savedStories.delete(storyId));
}

/** Whether a story is currently saved for offline reading. */
export async function isStorySaved(storyId: string): Promise<boolean> {
  try {
    return (await savedStories.get(storyId)) !== undefined;
  } catch {
    return false;
  }
}

/** List saved stories, most-recently-saved first; empty when unavailable. */
export async function listSavedStories(): Promise<SavedStoryRecord[]> {
  try {
    const records = await savedStories.getAll();
    return records.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}
