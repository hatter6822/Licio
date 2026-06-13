// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Offline store (WS-C.2.2/2.3): IndexedDB schema + integrity layer (zod on
// read/write), the background-sync pending queue, the sync processor, and iOS
// eviction detection.
export {
  DB_NAME,
  DB_VERSION,
  getDb,
  openDb,
  resetDbConnection,
  STORE,
  type StoreName,
} from './db.js';
export {
  type DraftCipher,
  decryptDraftValues,
  encryptDraftValues,
  resetDraftKeyCache,
} from './draft-crypto.js';
export {
  DRAFT_MAX_AGE_MS,
  type DraftInput,
  deleteDraft,
  deleteStoryDraft,
  expireOldDrafts,
  listDraftsForThread,
  listStoryDrafts,
  loadDraft,
  loadStoryDraft,
  type StoryDraftInput,
  saveDraft,
  saveStoryDraft,
} from './drafts.js';
export {
  type EvictionCallbacks,
  type IntegrityVerdict,
  initEvictionDetection,
  type ProbeResult,
  probeStorageIntegrity,
  requestPersistentStorage,
  snapshotStorage,
} from './eviction.js';
export { readNotificationsUsedToday, recordNotificationShown } from './notification-meter.js';
export * as queue from './queue.js';
export {
  cacheSignalLedger,
  cacheThreadSnapshot,
  isStorySaved,
  listSavedStories,
  readCachedSignalLedger,
  readThreadSnapshot,
  saveStory,
  unsaveStory,
} from './read-through.js';
export type {
  DraftContributionRecord,
  DraftStoryRecord,
  OperationType,
  PendingOperationRecord,
  SavedStoryRecord,
  SignalLedgerRecord,
  StoryDraftMode,
  ThreadSnapshotRecord,
} from './schemas.js';
export {
  draftContributions,
  draftStories,
  getRejectionCount,
  type IntegrityStore,
  resetRejectionCounts,
  savedStories,
  signalLedger,
  threadSnapshots,
} from './store.js';
export {
  initForegroundSync,
  MAX_QUEUE_ATTEMPTS,
  processPendingQueue,
  type SyncOptions,
  type SyncResult,
} from './sync.js';
