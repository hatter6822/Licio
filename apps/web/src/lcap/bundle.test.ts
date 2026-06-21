// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.1a/b — the offline `.licio-bundle` export/import flows running the REAL
// @licio/lcap pack codec client-side:
//   - a bundle exported by the gather→write path imports back with NO semantic change
//     (same CIDs, same payloads, room preserved) and lands at integrity-only trust;
//   - the §26.2 disclosure is computed BEFORE any file is produced;
//   - the pre-render summary reports counts/lanes/rooms/integrity;
//   - a malformed/truncated file is rejected cleanly with a typed status;
//   - a missing-dependency record is quarantined with its precise missing CIDs.
import 'fake-indexeddb/auto';
import { cidFor } from '@licio/lcap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildBundle,
  bundleFilename,
  exportDisclosure,
  gatherRoomExport,
  prepareRoomExport,
} from './bundle-export.js';
import { commitImportedBundle, importBundleObjects, readBundleForImport } from './bundle-import.js';
import {
  getLcapDb,
  LCAP_DB_VERSION,
  LCAP_MIGRATIONS,
  LCAP_STORE,
  openLcapDb,
  resetLcapDbConnection,
} from './db.js';
import { collectByCursor, type RecordRow } from './store.js';

let db: IDBDatabase;

beforeEach(async () => {
  db = await openLcapDb(
    `lcap_v2-bundle-${Math.random().toString(36).slice(2)}`,
    LCAP_DB_VERSION,
    LCAP_MIGRATIONS,
  );
});

afterEach(() => db.close());

function put(store: string, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Seed one record + its proof into a room; returns the real CIDs. */
async function seedRecord(
  roomHash: string,
  text: string,
  over: Partial<RecordRow> = {},
): Promise<{ recordCid: string; proofCid: string; body: Uint8Array }> {
  const body = new TextEncoder().encode(text);
  const recordCid = await cidFor('record', body);
  const proofBody = new TextEncoder().encode(`proof:${text}`);
  const proofCid = await cidFor('proof', proofBody);
  await put(LCAP_STORE.records, {
    recordCid,
    body,
    kind: 'contribution_event',
    lane: 'T1',
    priority: 1,
    roomHash,
    state: 'proof_verified',
    size: body.length,
    ...over,
  });
  await put(LCAP_STORE.proofs, {
    proofCid,
    proofBody,
    recordCid,
    signerKeyId: 'device-1',
    verificationState: 'verified',
  });
  return { recordCid, proofCid, body };
}

describe('bundle export → import round-trip (WS-R.15.1a/b)', () => {
  it('re-imports an exported room with no semantic change, at integrity-only trust', async () => {
    const a1 = await seedRecord('room-A', 'first in A');
    const a2 = await seedRecord('room-A', 'second in A');
    await seedRecord('room-B', 'only in B'); // must NOT be exported

    const exportData = await gatherRoomExport(db, 'room-A');
    expect(exportData.recordCount).toBe(2);
    expect(exportData.proofCount).toBe(2);

    const disclosure = await exportDisclosure(exportData.items);
    const bundle = await buildBundle({ objects: exportData.objects, disclosure });

    // Import into a FRESH store.
    const db2 = await openLcapDb(
      `lcap_v2-bundle-import-${Math.random().toString(36).slice(2)}`,
      LCAP_DB_VERSION,
      LCAP_MIGRATIONS,
    );
    const read = await readBundleForImport(bundle);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.summary.byKind.record).toBe(2);
    expect(read.summary.rooms).toEqual(['room-A']);
    expect(read.summary.integrityFailed).toBe(0);

    const importResult = await importBundleObjects(read.pack);
    const counts = await commitImportedBundle(db2, read.pack, importResult);
    expect(counts.records).toBe(2);
    expect(counts.proofs).toBe(2);

    const stored = await collectByCursor<RecordRow>(db2, LCAP_STORE.records);
    const storedByCid = new Map(stored.map((r) => [r.recordCid, r]));
    for (const seeded of [a1, a2]) {
      const row = storedByCid.get(seeded.recordCid);
      expect(row).toBeDefined();
      expect(row?.body).toEqual(seeded.body); // payload preserved byte-for-byte
      expect(row?.roomHash).toBe('room-A'); // room round-trips
      expect(row?.state).toBe('integrity_verified'); // NOT authorized — no overclaim
    }
    db2.close();
  });

  it('computes the §26.2 disclosure (rooms, media, size) before producing a file', async () => {
    await seedRecord('room-A', 'a record');
    const exportData = await gatherRoomExport(db, 'room-A');
    const disclosure = await exportDisclosure(exportData.items);
    expect(disclosure.roomIds).toEqual(['room-A']);
    expect(disclosure.hasInRoomMetadata).toBe(true);
    expect(disclosure.recipientsMayCopyOnward).toBe(true);
    expect(disclosure.approxSizeBytes).toBeGreaterThan(0);
  });

  it('prepareRoomExport gathers + discloses against the shared lcap_v2 connection', async () => {
    // Drive the memoised-connection convenience wrapper against the default db.
    resetLcapDbConnection();
    const shared = await getLcapDb();
    const body = new TextEncoder().encode('shared-conn record');
    const recordCid = await cidFor('record', body);
    await new Promise<void>((res, rej) => {
      const tx = shared.transaction(LCAP_STORE.records, 'readwrite');
      tx.objectStore(LCAP_STORE.records).put({
        recordCid,
        body,
        kind: 'contribution_event',
        lane: 'T1',
        priority: 1,
        roomHash: 'room-shared',
        state: 'proof_verified',
        size: body.length,
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    const prepared = await prepareRoomExport('room-shared');
    expect(prepared.recordCount).toBe(1);
    expect(prepared.disclosure.roomIds).toEqual(['room-shared']);
    shared.close();
    resetLcapDbConnection();
  });
});

describe('bundle import — typed rejection + summary (WS-R.15.1b)', () => {
  it('rejects a non-bundle file with a typed status (no crash, no render)', async () => {
    const outcome = await readBundleForImport(new Uint8Array([1, 2, 3, 4]));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe('bad_magic');
  });

  it('rejects a truncated bundle cleanly', async () => {
    await seedRecord('room-A', 'a record');
    const exportData = await gatherRoomExport(db, 'room-A');
    const disclosure = await exportDisclosure(exportData.items);
    const bundle = await buildBundle({ objects: exportData.objects, disclosure });
    const truncated = bundle.slice(0, bundle.length - 4);
    const outcome = await readBundleForImport(truncated);
    expect(outcome.ok).toBe(false);
  });
});

describe('bundle import — quarantine (WS-R.4.3)', () => {
  it('quarantines a record whose dependency is absent, recording the missing CID', async () => {
    const missingDep = await cidFor('block', new TextEncoder().encode('absent block'));
    await seedRecord('room-A', 'needs a block', { deps: [missingDep] });
    const exportData = await gatherRoomExport(db, 'room-A');
    // The dep block is NOT held, so it is not in the pack — the record must quarantine.
    const disclosure = await exportDisclosure(exportData.items);
    const bundle = await buildBundle({ objects: exportData.objects, disclosure });

    const db2 = await openLcapDb(
      `lcap_v2-bundle-q-${Math.random().toString(36).slice(2)}`,
      LCAP_DB_VERSION,
      LCAP_MIGRATIONS,
    );
    const read = await readBundleForImport(bundle);
    if (!read.ok) throw new Error('read failed');
    const importResult = await importBundleObjects(read.pack);
    const counts = await commitImportedBundle(db2, read.pack, importResult);
    expect(counts.quarantined).toBe(1);
    expect(counts.missingCids).toContain(missingDep);
    expect(counts.records).toBe(0); // the record is held back, not stored as renderable
    db2.close();
  });
});

describe('bundle filename (§26.3 / WS-R.4.4)', () => {
  it('uses a room/topic-free generic name for a high-risk export', async () => {
    const generic = await bundleFilename({ highRisk: true, roomHash: 'room-A', atMs: 0 });
    expect(generic).not.toContain('room');
    expect(generic.endsWith('.licio-bundle')).toBe(true);
  });

  it('distinguishes a normal export with a short non-reversible room slice', async () => {
    const normal = await bundleFilename({ highRisk: false, roomHash: 'abcdef0123456789', atMs: 0 });
    const generic = await bundleFilename({ highRisk: true, roomHash: 'abcdef0123456789', atMs: 0 });
    expect(normal).not.toBe(generic); // the two postures produce different names
    expect(normal).toContain('abcdef01'); // a SHORT slice only
    expect(normal).not.toContain('abcdef0123456789'); // never the full hash
  });
});
