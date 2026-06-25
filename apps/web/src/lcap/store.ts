// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.3b — the §23.2 IndexedDB durability + access layer over the WS-R.11.3a
// `lcap_v2` schema.  ALL lcap_v2 store access funnels through here.  Guarantees:
//
//   - cursor-only iteration (NEVER `getAll` on records/blocks/chunks) → bounded
//     memory, with early-stop so a capped read never scans the whole store;
//   - metadata↔blob separation: a block's descriptor lives in `blocks`, its bytes are
//     chunked into `chunks`, so reading a descriptor never deserializes the payload;
//   - TRANSACTIONAL verification-state commit: a record's body + proof + trust-state
//     commit atomically (a sync error aborts the whole transaction), so a crash never
//     leaves a half-verified record;
//   - capped transactions: a large import is split into bounded transactions (old
//     phones choke on huge ones);
//   - transient-quota retry: on `QuotaExceededError`, shed P4 ambient cache per §21.2
//     (`selectForEviction`) and retry once, surfacing residual pressure honestly.

import type { HeldObject } from '@licio/lcap';
import { LCAP_STORE, type LcapStoreName } from './db.js';
import { type GcCandidate, selectForEviction } from './gc.js';

/** Default per-transaction write cap (old-phone safe). */
export const DEFAULT_TX_CAP = 500;
/** Default bytes to shed on a quota-pressure retry. */
export const DEFAULT_SHED_BYTES = 8 * 1024 * 1024;

// --- Row shapes: the §23.1 value fields the durability layer reads/writes. --------

export interface RecordRow {
  readonly recordCid: string;
  readonly body: Uint8Array;
  readonly kind: string;
  readonly lane: string;
  readonly priority: number;
  readonly roomHash: string;
  readonly state: string;
  readonly size: number;
  readonly deps?: readonly string[];
}

export interface ProofRow {
  readonly proofCid: string;
  readonly proofBody: Uint8Array;
  readonly recordCid: string;
  readonly signerKeyId: string;
  readonly verificationState: string;
}

export interface TrustRow {
  readonly recordCid: string;
  readonly state: string;
  readonly missingDeps?: readonly string[];
  readonly lastEvaluated: number;
}

export interface BlockDescriptorRow {
  readonly blockCid: string;
  readonly state: string;
  readonly size: number;
  readonly chunkCount: number;
}

export interface ChunkRow {
  readonly blockCid: string;
  readonly chunkIndex: number;
  readonly bytes: Uint8Array;
}

// --- Promise plumbing over the raw IndexedDB request/transaction API. -------------

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

async function getByKey<T>(
  db: IDBDatabase,
  store: LcapStoreName,
  key: IDBValidKey,
): Promise<T | undefined> {
  const tx = db.transaction(store, 'readonly');
  const result = await promisifyRequest<T | undefined>(tx.objectStore(store).get(key));
  await txComplete(tx);
  return result;
}

/**
 * The subset of `keys` already present in `store`, checked via `getKey` (the primary key
 * only — NO value is deserialized) inside ONE readonly transaction.  Used to learn which
 * objects we already hold before a re-import, so already-held objects are NOT re-committed
 * (re-committing would overwrite a record we may hold at HIGHER trust — e.g. `authorized`
 * — back down to `integrity_verified`; trust projection is monotonic and must never be
 * downgraded by an import, WS-R.8.3).  All requests are issued synchronously on the same
 * transaction, so it stays alive until they settle.
 */
export async function filterPresentKeys(
  db: IDBDatabase,
  store: LcapStoreName,
  keys: readonly string[],
): Promise<Set<string>> {
  const present = new Set<string>();
  if (keys.length === 0) return present;
  const tx = db.transaction(store, 'readonly');
  const objectStore = tx.objectStore(store);
  await Promise.all(
    keys.map(async (key) => {
      const found = await promisifyRequest<IDBValidKey | undefined>(objectStore.getKey(key));
      if (found !== undefined) present.add(key);
    }),
  );
  await txComplete(tx);
  return present;
}

// --- Cursor-only iteration (NEVER getAll). ----------------------------------------

/**
 * Iterate a store via cursor, calling `fn` for each value.  `fn` may return `false`
 * to STOP early (the cursor is not advanced), so a bounded read never scans the whole
 * store.  Bounded memory: one row is held at a time.
 */
export async function forEachByCursor<T>(
  db: IDBDatabase,
  store: LcapStoreName,
  fn: (value: T) => unknown,
  query?: IDBKeyRange,
  direction: IDBCursorDirection = 'next',
): Promise<void> {
  const tx = db.transaction(store, 'readonly');
  const request = tx.objectStore(store).openCursor(query ?? null, direction);
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (fn(cursor.value as T) === false) {
        resolve();
        return;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('cursor failed'));
  });
  await txComplete(tx);
}

/** Collect up to `limit` rows via cursor (stops early; bounded memory). */
export async function collectByCursor<T>(
  db: IDBDatabase,
  store: LcapStoreName,
  limit?: number,
  query?: IDBKeyRange,
): Promise<T[]> {
  const out: T[] = [];
  await forEachByCursor<T>(
    db,
    store,
    (value) => {
      out.push(value);
      return limit === undefined || out.length < limit;
    },
    query,
  );
  return out;
}

// --- Transactional verification-state commit (§23.2). -----------------------------

/**
 * Commit a record's body + its proof + its trust-state advance ATOMICALLY (one
 * transaction).  A synchronous failure on any write aborts the whole transaction, so
 * a crash mid-commit leaves NO half-verified record — every later trust-state read
 * sees either the full triple or nothing.
 */
export async function commitVerifiedRecord(
  db: IDBDatabase,
  input: { record: RecordRow; proof: ProofRow; trust: TrustRow },
): Promise<void> {
  const tx = db.transaction(
    [LCAP_STORE.records, LCAP_STORE.proofs, LCAP_STORE.trustProjection],
    'readwrite',
  );
  try {
    tx.objectStore(LCAP_STORE.records).put(input.record);
    tx.objectStore(LCAP_STORE.proofs).put(input.proof);
    tx.objectStore(LCAP_STORE.trustProjection).put(input.trust);
  } catch (err) {
    tx.abort(); // a sync error must roll back the puts already issued in this tx
    throw err;
  }
  await txComplete(tx);
}

// --- Block storage: metadata↔blob separation (§23.2). -----------------------------

/**
 * Store a block as a descriptor row (`blocks`) + its bytes chunked into `chunks`, in
 * ONE transaction.  Reading the descriptor never deserializes the payload.
 */
export async function putBlock(
  db: IDBDatabase,
  descriptor: Omit<BlockDescriptorRow, 'chunkCount'>,
  chunks: readonly Uint8Array[],
): Promise<void> {
  const tx = db.transaction([LCAP_STORE.blocks, LCAP_STORE.chunks], 'readwrite');
  try {
    tx.objectStore(LCAP_STORE.blocks).put({ ...descriptor, chunkCount: chunks.length });
    chunks.forEach((bytes, chunkIndex) => {
      tx.objectStore(LCAP_STORE.chunks).put({ blockCid: descriptor.blockCid, chunkIndex, bytes });
    });
  } catch (err) {
    tx.abort();
    throw err;
  }
  await txComplete(tx);
}

/** Read a block's descriptor (metadata only — never loads the payload). */
export function readBlockDescriptor(
  db: IDBDatabase,
  blockCid: string,
): Promise<BlockDescriptorRow | undefined> {
  return getByKey<BlockDescriptorRow>(db, LCAP_STORE.blocks, blockCid);
}

/** Reassemble a block's bytes from its ordered chunks (cursor, not getAll). */
export async function readBlockBytes(
  db: IDBDatabase,
  blockCid: string,
): Promise<Uint8Array | undefined> {
  const descriptor = await readBlockDescriptor(db, blockCid);
  if (!descriptor) return undefined;
  const parts: Uint8Array[] = [];
  const range = IDBKeyRange.bound([blockCid, 0], [blockCid, Number.MAX_SAFE_INTEGER]);
  await forEachByCursor<ChunkRow>(db, LCAP_STORE.chunks, (c) => void parts.push(c.bytes), range);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Read a HELD object by CID for the §16 content responder — probing the record / proof / block
 * stores (CIDs are content-addressed + globally unique, so at most one store holds any CID).
 * Returns the verifiable bytes + kind, or `undefined` when not held.  The kind is derived from
 * WHICH store holds it; the receiver re-verifies `cidFor(kind, bytes)` regardless, so a rare
 * standalone-chunk stored as a block self-corrects (it fails the receiver's CID check, never a
 * trust bypass).  Records/proofs read raw bytes (`body`/`proofBody`); blocks reassemble.
 */
export async function getHeldObject(db: IDBDatabase, cid: string): Promise<HeldObject | undefined> {
  const record = await getByKey<RecordRow>(db, LCAP_STORE.records, cid);
  if (record) return { kind: 'record', bytes: record.body };
  const proof = await getByKey<ProofRow>(db, LCAP_STORE.proofs, cid);
  if (proof) return { kind: 'proof', bytes: proof.proofBody };
  const block = await readBlockBytes(db, cid);
  if (block) return { kind: 'block', bytes: block };
  return undefined;
}

/** The proof CIDs attesting `recordCid` (via the `proofs.recordCid` index) — so a content PUSH
 *  can ferry a record together with its proofs (the receiver re-verifies every CID regardless). */
export async function proofCidsForRecord(db: IDBDatabase, recordCid: string): Promise<string[]> {
  const tx = db.transaction(LCAP_STORE.proofs, 'readonly');
  const index = tx.objectStore(LCAP_STORE.proofs).index('recordCid');
  const out: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(recordCid));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      out.push((cursor.value as ProofRow).proofCid);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('proof index cursor failed'));
  });
  await txComplete(tx);
  return out;
}

// --- Capped transactions (§23.2 old-phone safety). --------------------------------

/** Split `items` into batches of at most `cap` (pure). */
export function chunkArray<T>(items: readonly T[], cap: number): T[][] {
  if (cap < 1) throw new RangeError('cap must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += cap) out.push(items.slice(i, i + cap));
  return out;
}

/** Import many rows into one store, splitting into bounded (capped) transactions. */
export async function importInCappedTransactions<T>(
  db: IDBDatabase,
  store: LcapStoreName,
  items: readonly T[],
  cap: number = DEFAULT_TX_CAP,
): Promise<void> {
  for (const batch of chunkArray(items, cap)) {
    const tx = db.transaction(store, 'readwrite');
    try {
      const objectStore = tx.objectStore(store);
      for (const item of batch) objectStore.put(item);
    } catch (err) {
      tx.abort();
      throw err;
    }
    await txComplete(tx);
  }
}

// --- Transient-quota retry (§23.2 + §21.2 eviction). ------------------------------

/** `true` iff `err` is a storage-quota-exceeded failure. */
export function isQuotaExceeded(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22);
}

/** Delete one cid's content everywhere it lives (record, block descriptor + chunks, gc). */
async function deleteContentByCid(db: IDBDatabase, cid: string): Promise<void> {
  const tx = db.transaction(
    [LCAP_STORE.records, LCAP_STORE.blocks, LCAP_STORE.chunks, LCAP_STORE.gcIndex],
    'readwrite',
  );
  try {
    tx.objectStore(LCAP_STORE.records).delete(cid);
    tx.objectStore(LCAP_STORE.blocks).delete(cid);
    tx.objectStore(LCAP_STORE.gcIndex).delete(cid);
    tx.objectStore(LCAP_STORE.chunks).delete(
      IDBKeyRange.bound([cid, 0], [cid, Number.MAX_SAFE_INTEGER]),
    );
  } catch (err) {
    tx.abort();
    throw err;
  }
  await txComplete(tx);
}

/**
 * Run `write`; on a transient `QuotaExceededError`, shed P4 ambient cache (§21.2 via
 * `selectForEviction`, which NEVER touches a pin) and retry once.  If the retry still
 * fails, the error propagates — the caller surfaces honest storage pressure rather
 * than silently dropping a write or evicting pinned content.
 */
export async function putWithQuotaRetry(
  db: IDBDatabase,
  write: () => Promise<void>,
  evictionCandidates: () => Promise<readonly GcCandidate[]>,
  bytesToFree: number = DEFAULT_SHED_BYTES,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (!isQuotaExceeded(err)) throw err;
    const shed = selectForEviction(await evictionCandidates(), bytesToFree);
    for (const candidate of shed) await deleteContentByCid(db, candidate.cid);
    await write(); // retry once; a still-failing write propagates the pressure
  }
}
