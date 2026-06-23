// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7 — the apps/web IndexedDB adapter for the `PrivateRoomEngine`'s
// `PrivateRoomStorage` port.  It persists a private room's ENCRYPTED envelopes
// (ciphertext only — there is no plaintext field on a `PrivateEncryptedEnvelope`)
// in a DEDICATED `licio_private_p2p` database, isolated from the WS-C `licio`
// offline store and the WS-R `lcap_v2` store, so the E2EE room's content evolves
// independently and never mingles with the application-level caches.
//
// This adapter only TYPE-imports `@licio/private-p2p` (erased at build, so the
// crypto/protocol core stays out of the initial bundle — `check:private-p2p-split`
// forbids a static value import); the engine itself is loaded by a DYNAMIC import
// in `room-manager.ts`.  Raw IndexedDB, no `idb` dependency (Web-API-first).

import type { PrivateEncryptedEnvelope, PrivateRoomStorage } from '@licio/private-p2p';

export const PRIVATE_P2P_DB_NAME = 'licio_private_p2p';
/** v2 adds the `room_sessions` store (the device keys + MLS group + epoch keys a
 *  room needs to survive a reload — a private room is local-only). */
export const PRIVATE_P2P_DB_VERSION = 2;
const ENVELOPE_STORE = 'envelopes';
export const ROOM_SESSION_STORE = 'room_sessions';
const ROOM_INDEX = 'by_room';

interface StoredRow {
  readonly roomId: string;
  readonly opId: string;
  readonly envelope: PrivateEncryptedEnvelope;
}

export function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Open (and migrate) the shared `licio_private_p2p` database.  Migrations are
 *  additive object-store creations inside the single versionchange transaction,
 *  so a failed upgrade aborts atomically and leaves the DB at its prior version. */
export function openPrivateP2pDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PRIVATE_P2P_DB_NAME, PRIVATE_P2P_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENVELOPE_STORE)) {
        // A COMPOUND primary key (roomId, opId) makes the upsert idempotent per
        // room+op with no separator/escaping concern; the by_room index lists a
        // single room's envelopes for the engine's verify-on-load.
        const store = db.createObjectStore(ENVELOPE_STORE, { keyPath: ['roomId', 'opId'] });
        store.createIndex(ROOM_INDEX, 'roomId', { unique: false });
      }
      if (!db.objectStoreNames.contains(ROOM_SESSION_STORE)) {
        // One session per room (the local device's keys + MLS group + epoch keys).
        db.createObjectStore(ROOM_SESSION_STORE, { keyPath: 'roomId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error(`failed to open ${PRIVATE_P2P_DB_NAME}`));
  });
}

/**
 * A per-room IndexedDB `PrivateRoomStorage`.  `listEnvelopes` returns exactly
 * this room's envelopes (the `by_room` index) for the engine's verify-on-load;
 * `putEnvelope` is an idempotent upsert on the compound (roomId, opId) key.
 */
export class IndexedDbPrivateRoomStorage implements PrivateRoomStorage {
  constructor(private readonly roomId: string) {}

  async putEnvelope(opId: string, envelope: PrivateEncryptedEnvelope): Promise<void> {
    const db = await openPrivateP2pDb();
    try {
      const tx = db.transaction(ENVELOPE_STORE, 'readwrite');
      const row: StoredRow = { roomId: this.roomId, opId, envelope };
      tx.objectStore(ENVELOPE_STORE).put(row);
      await txDone(tx);
    } finally {
      db.close();
    }
  }

  async listEnvelopes(): Promise<
    ReadonlyArray<{ opId: string; envelope: PrivateEncryptedEnvelope }>
  > {
    const db = await openPrivateP2pDb();
    try {
      const tx = db.transaction(ENVELOPE_STORE, 'readonly');
      const index = tx.objectStore(ENVELOPE_STORE).index(ROOM_INDEX);
      const rows = (await promisify(index.getAll(this.roomId))) as StoredRow[];
      return rows.map((row) => ({ opId: row.opId, envelope: row.envelope }));
    } finally {
      db.close();
    }
  }

  /** Drop the §14.5-compaction-pruned envelopes (delete by the compound key). */
  async deleteEnvelopes(opIds: readonly string[]): Promise<void> {
    if (opIds.length === 0) return;
    const db = await openPrivateP2pDb();
    try {
      const tx = db.transaction(ENVELOPE_STORE, 'readwrite');
      const store = tx.objectStore(ENVELOPE_STORE);
      for (const opId of opIds) store.delete([this.roomId, opId]);
      await txDone(tx);
    } finally {
      db.close();
    }
  }
}
