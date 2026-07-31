// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.3a — the `lcap_v2` IndexedDB schema: all twelve §23.1 stores + their
// indexes, the versioned (atomic) migration scaffold, and the isolation guarantee
// that LCAP never opens/migrates the WS-C `licio` database.
import 'fake-indexeddb/auto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getLcapDb,
  LCAP_DB_NAME,
  LCAP_MIGRATIONS,
  LCAP_STORE,
  type LcapMigrationMap,
  openLcapDb,
  resetLcapDbConnection,
} from './db.js';

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  resetLcapDbConnection();
  await deleteDatabase(LCAP_DB_NAME);
});

afterEach(() => {
  resetLcapDbConnection();
});

describe('lcap_v2 schema creation', () => {
  it('creates all twelve §23.1 object stores', async () => {
    const db = await getLcapDb();
    expect([...db.objectStoreNames].sort()).toEqual(
      [
        LCAP_STORE.records,
        LCAP_STORE.proofs,
        LCAP_STORE.blocks,
        LCAP_STORE.chunks,
        LCAP_STORE.manifests,
        LCAP_STORE.outbox,
        LCAP_STORE.quarantine,
        LCAP_STORE.trustProjection,
        LCAP_STORE.liveness,
        LCAP_STORE.frontiers,
        LCAP_STORE.receipts,
        LCAP_STORE.gcIndex,
      ].sort(),
    );
  });

  it('defines the room / priority / trust-state indexes on records', async () => {
    const db = await getLcapDb();
    const indexes = [
      ...db.transaction(LCAP_STORE.records, 'readonly').objectStore(LCAP_STORE.records).indexNames,
    ];
    expect(indexes.sort()).toEqual(['priority', 'roomHash', 'state']);
  });

  it('defines the pin-class index on gc_index (§21.2 eviction order)', async () => {
    const db = await getLcapDb();
    const indexes = [
      ...db.transaction(LCAP_STORE.gcIndex, 'readonly').objectStore(LCAP_STORE.gcIndex).indexNames,
    ];
    expect(indexes.sort()).toEqual(['lastAccess', 'pinClass']);
  });

  it('keys chunks by the (block_cid, chunk_index) composite + indexes blockCid', async () => {
    const db = await getLcapDb();
    const store = db.transaction(LCAP_STORE.chunks, 'readonly').objectStore(LCAP_STORE.chunks);
    expect(store.keyPath).toEqual(['blockCid', 'chunkIndex']);
    expect([...store.indexNames]).toEqual(['blockCid']);
  });

  it('defines the multiEntry subject-cids index on receipts', async () => {
    const db = await getLcapDb();
    const idx = db
      .transaction(LCAP_STORE.receipts, 'readonly')
      .objectStore(LCAP_STORE.receipts)
      .index('subjectCids');
    expect(idx.multiEntry).toBe(true);
  });

  it('round-trips a record by key and finds it via the room index', async () => {
    const db = await getLcapDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LCAP_STORE.records, 'readwrite');
      tx.objectStore(LCAP_STORE.records).put({
        recordCid: 'lcapr_x',
        kind: 'contribution_event',
        roomHash: 'room-hash-1',
        priority: 1,
        state: 'authorized_provisional',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const byRoom = await new Promise<unknown[]>((resolve, reject) => {
      const req = db
        .transaction(LCAP_STORE.records, 'readonly')
        .objectStore(LCAP_STORE.records)
        .index('roomHash')
        .getAll('room-hash-1');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(byRoom).toHaveLength(1);
  });
});

describe('versionchange self-close', () => {
  it('drops the memo so getLcapDb() reopens after a versionchange self-close', async () => {
    // Prime the memoised connection through getLcapDb().
    await getLcapDb();

    // Fire `versionchange` on the live connection (a deleteDatabase from
    // "another tab" is the simplest trigger). The handler closes the connection
    // and — with the fix — clears the module memo, so getLcapDb() no longer
    // hands out the dead handle (every request on it rejects InvalidStateError).
    await deleteDatabase(LCAP_DB_NAME);

    const db = await getLcapDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LCAP_STORE.records, 'readwrite');
      tx.objectStore(LCAP_STORE.records).put({
        recordCid: 'lcapr_after_versionchange',
        kind: 'contribution_event',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const req = db
        .transaction(LCAP_STORE.records, 'readonly')
        .objectStore(LCAP_STORE.records)
        .get('lcapr_after_versionchange');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(stored).toBeDefined();
  });
});

describe('lcap_v2 versioned migration', () => {
  it('adds a store on a version bump without losing existing data', async () => {
    const name = `lcap_v2-upgrade-${Math.random().toString(36).slice(2)}`;
    const v1 = await openLcapDb(name, 1, LCAP_MIGRATIONS);
    await new Promise<void>((resolve, reject) => {
      const tx = v1.transaction(LCAP_STORE.records, 'readwrite');
      tx.objectStore(LCAP_STORE.records).put({ recordCid: 'keep-me', kind: 'block_descriptor' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    v1.close();

    const v2Migrations: LcapMigrationMap = {
      ...LCAP_MIGRATIONS,
      2: (db) => {
        db.createObjectStore('future_store', { keyPath: 'id' });
      },
    };
    const v2 = await openLcapDb(name, 2, v2Migrations);
    expect([...v2.objectStoreNames]).toContain('future_store');
    const kept = await new Promise<unknown>((resolve, reject) => {
      const req = v2
        .transaction(LCAP_STORE.records, 'readonly')
        .objectStore(LCAP_STORE.records)
        .get('keep-me');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(kept).toBeDefined(); // preserved across the additive upgrade
    v2.close();
    await deleteDatabase(name);
  });

  it('aborts atomically and keeps the old version when a migration throws', async () => {
    const name = `lcap_v2-fail-${Math.random().toString(36).slice(2)}`;
    const v1 = await openLcapDb(name, 1, LCAP_MIGRATIONS);
    v1.close();

    const failing: LcapMigrationMap = {
      ...LCAP_MIGRATIONS,
      2: () => {
        throw new Error('boom');
      },
    };
    await expect(openLcapDb(name, 2, failing)).rejects.toBeTruthy();

    const reopened = await openLcapDb(name, 1, LCAP_MIGRATIONS);
    expect(reopened.version).toBe(1); // the failed upgrade rolled back
    reopened.close();
    await deleteDatabase(name);
  });
});

describe('lcap_v2 isolation from the WS-C `licio` database', () => {
  it('uses a distinct database name', () => {
    expect(LCAP_DB_NAME).toBe('lcap_v2');
    expect(LCAP_DB_NAME).not.toBe('licio');
  });

  // Static guarantee (WS-R.11.3a acceptance): no production file under
  // `apps/web/src/lcap` imports the WS-C offline DB or opens the `licio` database,
  // so LCAP versioning/GC/quarantine can never migrate or evict the WS-C stores.
  it('no production lcap/ file imports offline/db or opens the licio database', () => {
    // cwd is the repo root or apps/web depending on the runner — probe both.
    const dir = [
      resolve(process.cwd(), 'apps/web/src/lcap'),
      resolve(process.cwd(), 'src/lcap'),
    ].find((candidate) => {
      try {
        return readdirSync(candidate).length > 0;
      } catch {
        return false;
      }
    });
    expect(dir, 'could not locate apps/web/src/lcap').toBeDefined();
    const sources: string[] = [];
    const walk = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = `${path}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) sources.push(full);
      }
    };
    walk(dir as string);
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must not import the WS-C offline DB`).not.toMatch(
        /from\s+['"][^'"]*offline\/db/,
      );
      expect(src, `${file} must not open the licio database`).not.toMatch(
        /indexedDB\.open\(\s*['"]licio['"]/,
      );
    }
  });
});
