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
export { type DraftInput, loadDraft, saveDraft } from './drafts.js';
export {
  type EvictionCallbacks,
  type IntegrityVerdict,
  initEvictionDetection,
  type ProbeResult,
  probeStorageIntegrity,
  requestPersistentStorage,
  snapshotStorage,
} from './eviction.js';
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
  OperationType,
  PendingOperationRecord,
  SavedStoryRecord,
  SignalLedgerRecord,
  ThreadSnapshotRecord,
} from './schemas.js';
export {
  draftContributions,
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
