// SPDX-License-Identifier: AGPL-3.0-or-later
//
// IndexedDB connection + schema + migration (WS-C.2.2a, SPEC §6.9). A thin typed
// Promise wrapper over the raw IndexedDB API — no `idb` dependency (Web-API-first
// doctrine). Five object stores back offline reading, drafts, snapshots, the
// private Signal Ledger, and the background-sync pending queue. Migrations run
// inside the single `onupgradeneeded` versionchange transaction, so a failed
// migration aborts atomically and leaves the database at its previous version
// (never half-migrated, WS-C.2.2c).

export const DB_NAME = 'licio';
export const DB_VERSION = 3;

/** Object-store names (WS-C.2.2a object-store table). */
export const STORE = {
  savedStories: 'saved-stories',
  draftContributions: 'draft-contributions',
  draftStories: 'draft-stories',
  threadSnapshots: 'thread-snapshots',
  signalLedger: 'signal-ledger',
  pendingQueue: 'pending-queue',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

/**
 * A migration creates/updates stores (via `db`) and may transform existing
 * records (via the versionchange `tx`) for one version step.
 */
export type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;
export type MigrationMap = Record<number, Migration>;

/**
 * Version migrations, keyed by the target version. Applied in order for every
 * step between the existing and the current version. Adding an index or
 * transforming records belongs here under a new version key.
 */
export const MIGRATIONS: MigrationMap = {
  1: (db) => {
    const saved = db.createObjectStore(STORE.savedStories, { keyPath: 'storyId' });
    saved.createIndex('savedAt', 'savedAt');
    saved.createIndex('roomId', 'roomId');

    const drafts = db.createObjectStore(STORE.draftContributions, { keyPath: 'draftId' });
    drafts.createIndex('storyId', 'storyId');
    drafts.createIndex('threadId', 'threadId');
    drafts.createIndex('updatedAt', 'updatedAt');
    drafts.createIndex('contributionType', 'contributionType');

    const snapshots = db.createObjectStore(STORE.threadSnapshots, { keyPath: 'threadId' });
    snapshots.createIndex('cachedAt', 'cachedAt');

    const ledger = db.createObjectStore(STORE.signalLedger, { keyPath: 'itemId' });
    ledger.createIndex('recordedAt', 'recordedAt');

    const queue = db.createObjectStore(STORE.pendingQueue, { keyPath: 'operationId' });
    queue.createIndex('createdAt', 'createdAt');
    queue.createIndex('operationType', 'operationType');
    queue.createIndex('status', 'status');
  },
  // WS-Q.5.5 — the content–room model changed server read shapes (room_id +
  // visibility on stories; binary room visibility). Evict the read-model CACHE
  // (thread snapshots) so pre-WS-Q shapes are refetched, never mis-parsed. User
  // data is preserved: drafts, the pending queue, saved stories, and the signal
  // ledger are NOT cleared — a queued submission is never silently dropped.
  2: (_db, tx) => {
    tx.objectStore(STORE.threadSnapshots).clear();
  },
  // WS-Q.5.1b — the story composer autosaves an encrypted draft (room +
  // visibility + the text fields) so a half-written post survives a reload or a
  // tab switch. A dedicated store: story modes are NOT contribution types, so
  // the draft-contributions store (keyed on a strict contribution-type enum)
  // cannot hold them.
  3: (db) => {
    const stories = db.createObjectStore(STORE.draftStories, { keyPath: 'draftId' });
    stories.createIndex('updatedAt', 'updatedAt');
  },
};

function applyMigrations(
  db: IDBDatabase,
  tx: IDBTransaction,
  oldVersion: number,
  newVersion: number,
  migrations: MigrationMap,
): void {
  for (let version = oldVersion + 1; version <= newVersion; version += 1) {
    migrations[version]?.(db, tx);
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Open (creating/upgrading) the database. Rejects where IndexedDB is absent. */
export function openDb(
  name = DB_NAME,
  version = DB_VERSION,
  migrations: MigrationMap = MIGRATIONS,
): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable in this environment'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = (event) => {
      const tx = request.transaction;
      if (!tx) throw new Error('Missing versionchange transaction');
      // Any throw here aborts the versionchange transaction atomically, so a
      // failed migration leaves the database at its previous version.
      applyMigrations(
        request.result,
        tx,
        event.oldVersion,
        event.newVersion ?? version,
        migrations,
      );
    };
    request.onsuccess = () => {
      const db = request.result;
      // If another tab triggers an upgrade, close so it is not blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => {
      // Another tab holds an older connection open. It receives `versionchange`
      // and closes; the upgrade then proceeds. Surfaced via the open promise.
    };
  });
}

/** Shared, memoised connection for the app. */
export function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

/** Drop the memoised connection (tests / forced reconnect). */
export function resetDbConnection(): void {
  dbPromise = null;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

// --- Raw (unvalidated) record access. The integrity layer (store.ts) wraps
// these with zod validation; nothing else should call them directly. ---------

export async function rawPut(store: StoreName, value: unknown): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txComplete(tx);
}

export async function rawGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await getDb();
  const tx = db.transaction(store, 'readonly');
  const result = await promisifyRequest<T | undefined>(tx.objectStore(store).get(key));
  await txComplete(tx);
  return result;
}

export async function rawGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await getDb();
  const tx = db.transaction(store, 'readonly');
  const result = await promisifyRequest<T[]>(tx.objectStore(store).getAll());
  await txComplete(tx);
  return result;
}

export async function rawGetAllByIndex<T>(
  store: StoreName,
  index: string,
  query?: IDBValidKey | IDBKeyRange,
): Promise<T[]> {
  const db = await getDb();
  const tx = db.transaction(store, 'readonly');
  const idx = tx.objectStore(store).index(index);
  const result = await promisifyRequest<T[]>(
    query === undefined ? idx.getAll() : idx.getAll(query),
  );
  await txComplete(tx);
  return result;
}

export async function rawDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txComplete(tx);
}

export async function rawClear(store: StoreName): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await txComplete(tx);
}

export async function rawCount(store: StoreName): Promise<number> {
  const db = await getDb();
  const tx = db.transaction(store, 'readonly');
  const result = await promisifyRequest<number>(tx.objectStore(store).count());
  await txComplete(tx);
  return result;
}
