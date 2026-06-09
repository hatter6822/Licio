// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Offline read-through cache (WS-C.2.2a, SPEC §6.9). Write-through on a successful
// network read, read-back when the network is unavailable. Every mapping crosses
// the zod-validated integrity layer (store.ts), and EVERY operation here is
// best-effort: a missing/*full* IndexedDB never throws into the read path, so
// caching can only ever HELP — the network result is returned regardless. The
// orchestration that prefers network then falls back to cache lives in the query
// layer (lib/queries.ts); this module is the pure cache mapping.
import type { SignalLedgerEntry, StoryDetail, ThreadDetail } from '@licio/shared';
import type { SavedStoryRecord, SignalLedgerRecord, ThreadSnapshotRecord } from './schemas.js';
import { RECORD_SCHEMA_VERSION } from './schemas.js';
import { savedStories, signalLedger, threadSnapshots } from './store.js';

/** Run a storage side-effect, swallowing any error (offline storage is best-effort). */
async function bestEffort(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch {
    // IndexedDB absent, quota exceeded, or evicted — non-fatal for the read path.
  }
}

// --- Signal Ledger (private; non-lossy round-trip) ------------------------

function entryToLedgerRecord(entry: SignalLedgerEntry): SignalLedgerRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    itemId: entry.item_id,
    storyTitle: entry.story_title,
    recordedAt: Date.parse(entry.recorded_at),
    activeDwellBucket: entry.active_dwell_bucket,
    sourceOpened: entry.source_opened,
    contextOpened: entry.context_opened,
    branchDepthBucket: entry.branch_depth_bucket,
    returnVisitCountBucket: entry.return_visit_count_bucket,
    capReached: entry.cap_reached,
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
    branch_depth_bucket: record.branchDepthBucket,
    return_visit_count_bucket: record.returnVisitCountBucket,
    cap_reached: record.capReached,
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

// --- Thread snapshots (lossy summary for offline reading) -----------------

/** Cache a thread's title + current summary for offline reading. */
export async function cacheThreadSnapshot(detail: ThreadDetail): Promise<void> {
  await bestEffort(() =>
    threadSnapshots.put({
      schemaVersion: RECORD_SCHEMA_VERSION,
      threadId: detail.thread_id,
      title: detail.title,
      summary: detail.current_summary ?? '',
      cachedAt: Date.now(),
    }),
  );
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
      roomId: null,
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
