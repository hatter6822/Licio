// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.3b — the §23.2 durability layer: cursor-only streaming, blob↔metadata
// separation, transactional verification-state commit (atomicity), capped
// transactions, and transient-quota retry with §21.2 eviction.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LCAP_DB_VERSION, LCAP_MIGRATIONS, LCAP_STORE, openLcapDb } from './db.js';
import {
  chunkArray,
  collectByCursor,
  commitVerifiedRecord,
  forEachByCursor,
  importInCappedTransactions,
  isQuotaExceeded,
  type ProofRow,
  putBlock,
  putWithQuotaRetry,
  type RecordRow,
  readBlockBytes,
  readBlockDescriptor,
} from './store.js';

let db: IDBDatabase;

beforeEach(async () => {
  db = await openLcapDb(
    `lcap_v2-store-${Math.random().toString(36).slice(2)}`,
    LCAP_DB_VERSION,
    LCAP_MIGRATIONS,
  );
});

afterEach(() => {
  db.close();
});

function record(over: Partial<RecordRow> = {}): RecordRow {
  return {
    recordCid: 'lcapr_a',
    body: new Uint8Array([1, 2, 3]),
    kind: 'contribution_event',
    lane: 'T1',
    priority: 1,
    roomHash: 'room-1',
    state: 'proof_verified',
    size: 3,
    ...over,
  };
}

function put(store: string, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function count(store: string): Promise<number> {
  const tx = db.transaction(store, 'readonly');
  const req = tx.objectStore(store).count();
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const tx = db.transaction(store, 'readonly');
  const req = tx.objectStore(store).get(key) as IDBRequest<T | undefined>;
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

describe('cursor-only iteration', () => {
  it('streams every row via cursor (no getAll)', async () => {
    for (let i = 0; i < 5; i += 1) await put(LCAP_STORE.records, record({ recordCid: `r-${i}` }));
    const seen: string[] = [];
    await forEachByCursor<RecordRow>(db, LCAP_STORE.records, (r) => void seen.push(r.recordCid));
    expect(seen.sort()).toEqual(['r-0', 'r-1', 'r-2', 'r-3', 'r-4']);
  });

  it('stops early when the callback returns false', async () => {
    for (let i = 0; i < 10; i += 1) await put(LCAP_STORE.records, record({ recordCid: `r-${i}` }));
    const first2 = await collectByCursor<RecordRow>(db, LCAP_STORE.records, 2);
    expect(first2).toHaveLength(2); // bounded read — did not scan all ten
  });
});

describe('transactional verification-state commit', () => {
  it('writes body + proof + trust-state atomically', async () => {
    await commitVerifiedRecord(db, {
      record: record({ recordCid: 'r1' }),
      proof: {
        proofCid: 'p1',
        proofBody: new Uint8Array([9]),
        recordCid: 'r1',
        signerKeyId: 'k',
        verificationState: 'verified',
      },
      trust: { recordCid: 'r1', state: 'proof_verified', lastEvaluated: 1 },
    });
    expect(await get(LCAP_STORE.records, 'r1')).toBeDefined();
    expect(await get(LCAP_STORE.proofs, 'p1')).toBeDefined();
    expect(await get(LCAP_STORE.trustProjection, 'r1')).toBeDefined();
  });

  it('leaves NO half-verified record when a mid-commit write fails (atomic rollback)', async () => {
    // The proof is missing its in-line key (proofCid) → its put throws synchronously,
    // which must abort the whole transaction and roll back the record already issued.
    const badProof = {
      proofBody: new Uint8Array([9]),
      recordCid: 'r2',
      signerKeyId: 'k',
      verificationState: 'verified',
    } as unknown as ProofRow;
    await expect(
      commitVerifiedRecord(db, {
        record: record({ recordCid: 'r2' }),
        proof: badProof,
        trust: { recordCid: 'r2', state: 'proof_verified', lastEvaluated: 1 },
      }),
    ).rejects.toBeTruthy();
    expect(await count(LCAP_STORE.records)).toBe(0); // the record.put rolled back
    expect(await count(LCAP_STORE.trustProjection)).toBe(0);
  });
});

describe('block metadata↔blob separation', () => {
  it('stores the descriptor separately from the chunked bytes and reassembles them', async () => {
    await putBlock(db, { blockCid: 'lcapb_x', state: 'verified', size: 6 }, [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
    ]);
    const descriptor = await readBlockDescriptor(db, 'lcapb_x');
    expect(descriptor).toMatchObject({ blockCid: 'lcapb_x', chunkCount: 2, size: 6 });
    expect((descriptor as unknown as Record<string, unknown>)['bytes']).toBeUndefined(); // metadata only
    expect(await readBlockBytes(db, 'lcapb_x')).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it('returns undefined bytes for an unknown block', async () => {
    expect(await readBlockBytes(db, 'lcapb_missing')).toBeUndefined();
  });
});

describe('capped transactions', () => {
  it('chunkArray splits into bounded batches', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunkArray([1], 0)).toThrow(RangeError);
  });

  it('imports every row across multiple bounded transactions', async () => {
    const rows = Array.from({ length: 23 }, (_, i) => record({ recordCid: `b-${i}` }));
    await importInCappedTransactions(db, LCAP_STORE.records, rows, 5); // 5 transactions of ≤5
    expect(await count(LCAP_STORE.records)).toBe(23);
  });
});

describe('transient-quota retry', () => {
  it('recognises a QuotaExceededError', () => {
    expect(isQuotaExceeded(new DOMException('full', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaExceeded(new Error('other'))).toBe(false);
  });

  it('sheds P4 ambient cache and retries once on quota pressure', async () => {
    await put(LCAP_STORE.records, record({ recordCid: 'evict-me', priority: 4 }));
    await put(LCAP_STORE.gcIndex, { cid: 'evict-me', pinClass: 'cache_pin', lastAccess: 1 });

    let attempts = 0;
    const write = async (): Promise<void> => {
      attempts += 1;
      if (attempts === 1) throw new DOMException('quota', 'QuotaExceededError');
    };
    await putWithQuotaRetry(
      db,
      write,
      async () => [
        {
          cid: 'evict-me',
          priority: 4,
          lane: 'B4',
          pinClass: 'cache_pin',
          old: true,
          roomSubscribed: false,
          quarantine: false,
          lastAccess: 1,
          size: 1000,
        },
      ],
      100,
    );
    expect(attempts).toBe(2); // failed once, retried after shedding
    expect(await get(LCAP_STORE.records, 'evict-me')).toBeUndefined(); // shed
  });

  it('propagates a non-quota error without retrying', async () => {
    let attempts = 0;
    const write = async (): Promise<void> => {
      attempts += 1;
      throw new Error('not a quota error');
    };
    await expect(putWithQuotaRetry(db, write, async () => [])).rejects.toThrow('not a quota error');
    expect(attempts).toBe(1); // never retried
  });
});

describe('§23.2 no-getAll guarantee', () => {
  it('the durability layer never calls getAll', () => {
    const dir = [
      resolve(process.cwd(), 'apps/web/src/lcap'),
      resolve(process.cwd(), 'src/lcap'),
    ].find((candidate) => {
      try {
        readFileSync(`${candidate}/store.ts`);
        return true;
      } catch {
        return false;
      }
    });
    expect(dir).toBeDefined();
    expect(readFileSync(`${dir}/store.ts`, 'utf8')).not.toMatch(/\.getAll\(/);
  });
});
