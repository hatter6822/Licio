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
 *  room needs to survive a reload — a private room is local-only).  v3 adds the
 *  `blocks` store: CID-addressed §13.6 attachment manifest + media-chunk ciphertext,
 *  fetched lazily over the §15.7 block exchange.  v4 adds `cap_secrets`: the Tier-2
 *  rendezvous-cap `nid` + issuer seed — device-local secrets held at the SAME trust
 *  boundary as the room epoch keys (off origin-wide localStorage).  v5 adds
 *  `invite_uses`: the admin-device-local per-invite acceptance counter that makes
 *  §10.3 `max_uses` (incl. single-use) actually enforceable across admits. */
export const PRIVATE_P2P_DB_VERSION = 5;
const ENVELOPE_STORE = 'envelopes';
export const ROOM_SESSION_STORE = 'room_sessions';
const BLOCK_STORE = 'blocks';
const CAP_SECRET_STORE = 'cap_secrets';
const INVITE_USES_STORE = 'invite_uses';
const ROOM_INDEX = 'by_room';

interface StoredRow {
  readonly roomId: string;
  readonly opId: string;
  readonly envelope: PrivateEncryptedEnvelope;
}

interface StoredBlockRow {
  readonly roomId: string;
  readonly cid: string;
  readonly bytes: Uint8Array;
}

interface StoredCapSecretRow {
  readonly roomId: string;
  readonly field: string;
  readonly bytes: Uint8Array;
}

interface StoredInviteUseRow {
  readonly roomId: string;
  readonly inviteId: string;
  readonly uses: number;
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
      if (!db.objectStoreNames.contains(BLOCK_STORE)) {
        // CID-addressed attachment blocks, compound (roomId, cid) key (idempotent
        // per room+CID — a content-addressed block is immutable, so re-put is a no-op).
        db.createObjectStore(BLOCK_STORE, { keyPath: ['roomId', 'cid'] });
      }
      if (!db.objectStoreNames.contains(CAP_SECRET_STORE)) {
        // One row per (roomId, field) — the Tier-2 cap `nid` + issuer seed.
        db.createObjectStore(CAP_SECRET_STORE, { keyPath: ['roomId', 'field'] });
      }
      if (!db.objectStoreNames.contains(INVITE_USES_STORE)) {
        // One row per (roomId, inviteId) — the admin-device-local acceptance
        // counter that enforces the invite's §10.3 `max_uses` budget.
        db.createObjectStore(INVITE_USES_STORE, { keyPath: ['roomId', 'inviteId'] });
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

  /** §13.6 — persist a CID-addressed attachment block (idempotent upsert on the
   *  compound (roomId, cid) key; the engine verified the CID before calling). */
  async putBlock(cid: string, bytes: Uint8Array): Promise<void> {
    const db = await openPrivateP2pDb();
    try {
      const tx = db.transaction(BLOCK_STORE, 'readwrite');
      const row: StoredBlockRow = { roomId: this.roomId, cid, bytes };
      tx.objectStore(BLOCK_STORE).put(row);
      await txDone(tx);
    } finally {
      db.close();
    }
  }

  async getBlock(cid: string): Promise<Uint8Array | undefined> {
    const db = await openPrivateP2pDb();
    try {
      const tx = db.transaction(BLOCK_STORE, 'readonly');
      const row = (await promisify(tx.objectStore(BLOCK_STORE).get([this.roomId, cid]))) as
        | StoredBlockRow
        | undefined;
      return row?.bytes;
    } finally {
      db.close();
    }
  }

  async hasBlock(cid: string): Promise<boolean> {
    const db = await openPrivateP2pDb();
    try {
      const tx = db.transaction(BLOCK_STORE, 'readonly');
      const key = (await promisify(tx.objectStore(BLOCK_STORE).getKey([this.roomId, cid]))) as
        | IDBValidKey
        | undefined;
      return key !== undefined;
    } finally {
      db.close();
    }
  }

  /** Read a Tier-2 cap secret (`nid` / `issuer-seed`) for this room, or undefined. */
  async getCapSecret(field: string): Promise<Uint8Array | undefined> {
    const db = await openPrivateP2pDb();
    try {
      const tx = db.transaction(CAP_SECRET_STORE, 'readonly');
      const row = (await promisify(tx.objectStore(CAP_SECRET_STORE).get([this.roomId, field]))) as
        | StoredCapSecretRow
        | undefined;
      return row?.bytes;
    } finally {
      db.close();
    }
  }

  /** Persist a Tier-2 cap secret for this room (idempotent on the (roomId, field) key). */
  async putCapSecret(field: string, bytes: Uint8Array): Promise<void> {
    const db = await openPrivateP2pDb();
    try {
      const tx = db.transaction(CAP_SECRET_STORE, 'readwrite');
      const row: StoredCapSecretRow = { roomId: this.roomId, field, bytes };
      tx.objectStore(CAP_SECRET_STORE).put(row);
      await txDone(tx);
    } finally {
      db.close();
    }
  }

  /** How many joins this invite has already been charged for on this admin device
   *  (0 if never used) — the base for the §10.3 `max_uses` budget check. */
  async getInviteUses(inviteId: string): Promise<number> {
    const db = await openPrivateP2pDb();
    try {
      const tx = db.transaction(INVITE_USES_STORE, 'readonly');
      const row = (await promisify(
        tx.objectStore(INVITE_USES_STORE).get([this.roomId, inviteId]),
      )) as StoredInviteUseRow | undefined;
      return row?.uses ?? 0;
    } finally {
      db.close();
    }
  }

  /** Charge one accepted join against this invite and return the NEW total.  The
   *  read-modify-write runs in ONE readwrite transaction so concurrent admits
   *  cannot double-spend a single-use invite (admits are also op-lock-serialized). */
  async incrementInviteUses(inviteId: string): Promise<number> {
    const db = await openPrivateP2pDb();
    try {
      const tx = db.transaction(INVITE_USES_STORE, 'readwrite');
      const store = tx.objectStore(INVITE_USES_STORE);
      const existing = (await promisify(store.get([this.roomId, inviteId]))) as
        | StoredInviteUseRow
        | undefined;
      const uses = (existing?.uses ?? 0) + 1;
      store.put({ roomId: this.roomId, inviteId, uses } satisfies StoredInviteUseRow);
      await txDone(tx);
      return uses;
    } finally {
      db.close();
    }
  }

  /** Purge EVERY row this adapter owns for its room — envelopes, blocks, cap
   *  secrets, and invite-use counters — in one atomic transaction.  Called from
   *  `leave()` so forgetting a room leaves no orphaned ciphertext/media/secrets
   *  behind.  Every store is compound-keyed `[roomId, …]`, so a single
   *  `[roomId] … [roomId, []]` range covers all of a room's rows (the empty array
   *  sorts after any scalar sub-key in IndexedDB key order). */
  async deleteAllForRoom(): Promise<void> {
    const db = await openPrivateP2pDb();
    try {
      const stores = [ENVELOPE_STORE, BLOCK_STORE, CAP_SECRET_STORE, INVITE_USES_STORE];
      const tx = db.transaction(stores, 'readwrite');
      const range = IDBKeyRange.bound([this.roomId], [this.roomId, []]);
      for (const name of stores) tx.objectStore(name).delete(range);
      await txDone(tx);
    } finally {
      db.close();
    }
  }
}
