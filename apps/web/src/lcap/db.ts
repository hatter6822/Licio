// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The dedicated `lcap_v2` IndexedDB database (WS-R.11.3a, OFFLINE_SPEC §23.1) — a
// SEPARATE database from the WS-C `licio` offline store (`offline/db.ts`), so LCAP's
// content-addressed objects, versioning, hard-pin GC (§21.2), and quarantine evolve
// without migrating the established offline stores, and LCAP's CID-addressed content
// stays out of the application-level caches.
//
// This module owns the SCHEMA SHAPE only — the twelve §23.1 object stores, their key
// paths, the secondary indexes (room / priority / state / pin-class), and the
// versioned `onupgradeneeded` migration scaffold.  The §23.2 access-pattern +
// durability layer (cursor-only streaming, blob↔metadata separation, transactional
// verification-state commit, capped transactions, quota retry) is WS-R.11.3b.
//
// Raw IndexedDB, no `idb` dependency (Web-API-first doctrine), mirroring the WS-C
// migration pattern: migrations run inside the single `onupgradeneeded`
// versionchange transaction, so a failed migration aborts atomically and leaves the
// database at its previous version (never half-migrated).

export const LCAP_DB_NAME = 'lcap_v2';
export const LCAP_DB_VERSION = 1;

/** The §23.1 object stores (LCAP content-addressed + sync-state stores). */
export const LCAP_STORE = {
  // record_cid -> body, kind, lane, priority, room_hash, state, size, deps
  records: 'records',
  // proof_cid -> proof_body, record_cid, signer_key_id, verification_state
  proofs: 'proofs',
  // block_cid -> blob/chunk bytes, descriptor, state, size
  blocks: 'blocks',
  // (block_cid, chunk_index) -> bytes, hash, received, verified
  chunks: 'chunks',
  // record_cid -> bundle/pack manifest metadata
  manifests: 'manifests',
  // record_cid -> local status, retries, next_retry, capability_id, body_block_cid
  outbox: 'outbox',
  // cid -> reason, first_seen, source_hint, missing_deps, byte_size
  quarantine: 'quarantine',
  // record_cid -> current trust state, missing deps, last evaluated
  trustProjection: 'trust_projection',
  // cid -> local_created, packed, exported, peer/relay/server_stored, accepted, …
  liveness: 'liveness',
  // room/account/global scope -> checkpoint/revocation/policy frontier
  frontiers: 'frontiers',
  // receipt_cid -> receipt body, issuer, subject cids
  receipts: 'receipts',
  // cid -> pin class, last access, evictable, size
  gcIndex: 'gc_index',
} as const;

export type LcapStoreName = (typeof LCAP_STORE)[keyof typeof LCAP_STORE];

/**
 * A migration creates/updates stores (via `db`) and may transform existing records
 * (via the versionchange `tx`) for one version step.
 */
export type LcapMigration = (db: IDBDatabase, tx: IDBTransaction) => void;
export type LcapMigrationMap = Record<number, LcapMigration>;

/**
 * Version migrations, keyed by the target version.  Applied in order for every step
 * between the existing and the current version.  Adding a store or index belongs
 * here under a new version key (never mutate a shipped migration).
 */
export const LCAP_MIGRATIONS: LcapMigrationMap = {
  1: (db) => {
    const records = db.createObjectStore(LCAP_STORE.records, { keyPath: 'recordCid' });
    records.createIndex('roomHash', 'roomHash'); // room lookup (§23.2)
    records.createIndex('priority', 'priority'); // priority lookup
    records.createIndex('state', 'state'); // trust-state lookup

    const proofs = db.createObjectStore(LCAP_STORE.proofs, { keyPath: 'proofCid' });
    proofs.createIndex('recordCid', 'recordCid'); // proofs attesting a record
    proofs.createIndex('verificationState', 'verificationState');

    const blocks = db.createObjectStore(LCAP_STORE.blocks, { keyPath: 'blockCid' });
    blocks.createIndex('state', 'state');

    // A block's chunks are keyed by (block_cid, chunk_index) for ordered reassembly.
    const chunks = db.createObjectStore(LCAP_STORE.chunks, {
      keyPath: ['blockCid', 'chunkIndex'],
    });
    chunks.createIndex('blockCid', 'blockCid');

    db.createObjectStore(LCAP_STORE.manifests, { keyPath: 'recordCid' });

    const outbox = db.createObjectStore(LCAP_STORE.outbox, { keyPath: 'recordCid' });
    outbox.createIndex('status', 'status');
    outbox.createIndex('nextRetry', 'nextRetry'); // retry scheduling

    const quarantine = db.createObjectStore(LCAP_STORE.quarantine, { keyPath: 'cid' });
    quarantine.createIndex('firstSeen', 'firstSeen'); // age-out of stale quarantine

    const trust = db.createObjectStore(LCAP_STORE.trustProjection, { keyPath: 'recordCid' });
    trust.createIndex('state', 'state');

    db.createObjectStore(LCAP_STORE.liveness, { keyPath: 'cid' });

    db.createObjectStore(LCAP_STORE.frontiers, { keyPath: 'scope' });

    const receipts = db.createObjectStore(LCAP_STORE.receipts, { keyPath: 'receiptCid' });
    // A receipt can attest several subject cids → a multiEntry index over the array.
    receipts.createIndex('subjectCids', 'subjectCids', { multiEntry: true });

    const gc = db.createObjectStore(LCAP_STORE.gcIndex, { keyPath: 'cid' });
    gc.createIndex('pinClass', 'pinClass'); // pin-class lookup (§21.2 eviction order)
    gc.createIndex('lastAccess', 'lastAccess'); // age-based eviction
  },
};

function applyMigrations(
  db: IDBDatabase,
  tx: IDBTransaction,
  oldVersion: number,
  newVersion: number,
  migrations: LcapMigrationMap,
): void {
  for (let version = oldVersion + 1; version <= newVersion; version += 1) {
    migrations[version]?.(db, tx);
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Open (creating/upgrading) the `lcap_v2` database. Rejects where IndexedDB is absent. */
export function openLcapDb(
  name = LCAP_DB_NAME,
  version = LCAP_DB_VERSION,
  migrations: LcapMigrationMap = LCAP_MIGRATIONS,
): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable in this environment'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = (event) => {
      const tx = request.transaction;
      if (!tx) throw new Error('Missing versionchange transaction');
      // Any throw here aborts the versionchange transaction atomically, so a failed
      // migration leaves the database at its previous version.
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
      // Another tab holds an older connection open. It receives `versionchange` and
      // closes; the upgrade then proceeds.
    };
  });
}

/** Shared, memoised `lcap_v2` connection. */
export function getLcapDb(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openLcapDb();
  return dbPromise;
}

/** Drop the memoised connection (tests / forced reconnect). */
export function resetLcapDbConnection(): void {
  dbPromise = null;
}
