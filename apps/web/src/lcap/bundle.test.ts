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
import { cidFor, writePack } from '@licio/lcap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildBundle,
  bundleFilename,
  exportDisclosure,
  gatherRoomExport,
  prepareRoomExport,
} from './bundle-export.js';
import {
  commitImportedBundle,
  heldCidsFor,
  importBundleObjects,
  readBundleForImport,
} from './bundle-import.js';
import {
  getLcapDb,
  LCAP_DB_VERSION,
  LCAP_MIGRATIONS,
  LCAP_STORE,
  openLcapDb,
  resetLcapDbConnection,
} from './db.js';
import { collectByCursor, putBlock, type RecordRow, readBlockBytes } from './store.js';

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
    // Room keys are the CANONICAL hex of the room_id_hash bytes (lossless) — so they round-trip.
    const roomA = 'a1a1a1a1a1a1a1a1';
    const roomB = 'b2b2b2b2b2b2b2b2';
    const a1 = await seedRecord(roomA, 'first in A');
    const a2 = await seedRecord(roomA, 'second in A');
    await seedRecord(roomB, 'only in B'); // must NOT be exported

    const exportData = await gatherRoomExport(db, roomA);
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
    expect(read.summary.rooms).toEqual([roomA]);
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
      expect(row?.roomHash).toBe(roomA); // room round-trips (canonical hex)
      expect(row?.state).toBe('integrity_verified'); // NOT authorized — no overclaim
    }
    db2.close();
  });

  it('SECURITY: export derives table deps from the signed body, dropping stale row.deps (#AE)', async () => {
    const lcap = await import('@licio/lcap');
    const bodyBlock = await cidFor('block', new Uint8Array([1, 1]));
    const staleBlock = await cidFor('block', new Uint8Array([2, 2]));
    const body = lcap.encodeContributionEvent({
      record_version: 2,
      kind: 'contribution_event',
      event_type: 'post',
      home_room_id: 'room-ae',
      visibility_scope: 'public',
      author_account_id: 'a',
      author_device_id: 'd',
      author_device_key_id: 'k',
      device_seq: 1,
      capability_cid: await cidFor('record', new Uint8Array([0])),
      policy_epoch_claim: 0,
      revocation_epoch_claim: 0,
      client_nonce: new Uint8Array([5]),
      priority: 2,
      body_block_cid: bodyBlock,
    });
    const recordCid = await cidFor('record', body);
    await put(LCAP_STORE.records, {
      recordCid,
      body,
      kind: 'contribution_event',
      lane: 'C0',
      priority: 2,
      roomHash: 'room-ae',
      state: 'integrity_verified',
      size: body.length,
      deps: [bodyBlock, staleBlock], // a STALE extra dep in the table metadata, not in the body
    });

    const exportData = await gatherRoomExport(db, 'room-ae');
    const recObj = exportData.objects.find((o) => o.cid === recordCid);
    expect(recObj?.deps).toContain(bodyBlock); // the authentic signed-body ref is carried
    expect(recObj?.deps ?? []).not.toContain(staleBlock); // the stale row.dep is dropped (#AE)
  });

  it('SECURITY: export derives block deps from the signed body, not row.deps metadata (#HH)', async () => {
    const lcap = await import('@licio/lcap');
    const roomHex = 'cccccccccccccccc';
    const ownBytes = new Uint8Array([3, 3, 3]);
    const ownBlockCid = await cidFor('block', ownBytes);
    const foreignBytes = new Uint8Array([4, 4, 4]);
    const foreignBlockCid = await cidFor('block', foreignBytes);
    await putBlock(db, { blockCid: ownBlockCid, state: 'integrity_verified', size: 3 }, [ownBytes]);
    await putBlock(db, { blockCid: foreignBlockCid, state: 'integrity_verified', size: 3 }, [
      foreignBytes,
    ]);
    // A real record whose SIGNED body references ONLY ownBlockCid; its row.deps ALSO lists the
    // foreign block (as pack-table metadata copied from an imported bundle would).
    const body = lcap.encodeContributionEvent({
      record_version: 2,
      kind: 'contribution_event',
      event_type: 'post',
      home_room_id: 'room-1',
      visibility_scope: 'public',
      author_account_id: 'a',
      author_device_id: 'd',
      author_device_key_id: 'k',
      device_seq: 1,
      capability_cid: await cidFor('record', new Uint8Array([0])),
      policy_epoch_claim: 0,
      revocation_epoch_claim: 0,
      client_nonce: new Uint8Array([1]),
      priority: 2,
      body_block_cid: ownBlockCid,
    });
    const recordCid = await cidFor('record', body);
    await put(LCAP_STORE.records, {
      recordCid,
      body,
      kind: 'contribution_event',
      lane: 'C0',
      priority: 2,
      roomHash: roomHex,
      state: 'integrity_verified',
      size: body.length,
      deps: [ownBlockCid, foreignBlockCid], // unauthenticated metadata lists BOTH
    });

    const exportData = await gatherRoomExport(db, roomHex);
    const exportedBlocks = exportData.objects
      .filter((o) => o.cidKind === 'block')
      .map((o) => o.cid);
    expect(exportedBlocks).toContain(ownBlockCid); // referenced by the SIGNED body → exported
    expect(exportedBlocks).not.toContain(foreignBlockCid); // only in row.deps → NOT exported (#HH)
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

describe('bundle import — private-encrypted bundles are refused by the public path (WS-R.16.1 / §8)', () => {
  it('refuses a contains_private_encrypted bundle with the typed private_bundle status', async () => {
    // A `contains_private_encrypted` pack carries WS-S private-room ciphertext, which
    // belongs ONLY in the device-local private engine — NEVER the public lcap_v2 store.
    // The public read path must refuse it BEFORE summarizing or committing.
    const ciphertext = new TextEncoder().encode('opaque private ciphertext bytes');
    const blockCid = await cidFor('block', ciphertext);
    const privateBundle = writePack({
      objects: [
        {
          cid: blockCid,
          cidKind: 'block',
          frameKind: 'block',
          payload: ciphertext,
          lane: 'B4',
          priority: 4,
          flags: { encrypted: true, private_metadata: true },
        },
      ],
      transportProfile: 'manual_bundle',
      privacyLabel: 'contains_private_encrypted',
      maxUncompressedBytes: 1 << 20,
    });

    const outcome = await readBundleForImport(privateBundle);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe('private_bundle');
  });

  it('still accepts an ordinary public bundle (the guard is label-scoped, not blanket)', async () => {
    await seedRecord('room-A', 'an ordinary public post');
    const exportData = await gatherRoomExport(db, 'room-A');
    const disclosure = await exportDisclosure(exportData.items);
    const bundle = await buildBundle({ objects: exportData.objects, disclosure });
    const outcome = await readBundleForImport(bundle);
    expect(outcome.ok).toBe(true); // a public/in-room bundle is NOT refused
  });
});

describe('bundle import — quarantine (WS-R.4.3)', () => {
  it('quarantines a record whose dependency is absent, recording the missing CID', async () => {
    const lcap = await import('@licio/lcap');
    const missingDep = await cidFor('block', new TextEncoder().encode('absent block'));
    // A REAL contribution whose SIGNED body references the (un-held) block — so the export carries
    // the AUTHENTIC dep (#AE: deps are derived from the body, not stale table metadata) and the
    // importer quarantines on it.
    const body = lcap.encodeContributionEvent({
      record_version: 2,
      kind: 'contribution_event',
      event_type: 'post',
      home_room_id: 'room-A',
      visibility_scope: 'public',
      author_account_id: 'a',
      author_device_id: 'd',
      author_device_key_id: 'k',
      device_seq: 1,
      capability_cid: await cidFor('record', new Uint8Array([0])),
      policy_epoch_claim: 0,
      revocation_epoch_claim: 0,
      client_nonce: new Uint8Array([9]),
      priority: 1,
      body_block_cid: missingDep,
    });
    const recordCid = await cidFor('record', body);
    await put(LCAP_STORE.records, {
      recordCid,
      body,
      kind: 'contribution_event',
      lane: 'T1',
      priority: 1,
      roomHash: 'room-A',
      state: 'integrity_verified',
      size: body.length,
      deps: [missingDep],
    });
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

  it('SECURITY: an UNSCOPED manual import re-quarantines a record whose SIGNED body needs a block the table OMITS (#BI)', async () => {
    // The reviewer finding (#BI): on the manual import path (no roomAllowlist, publicOnly false)
    // the old guard skipped decoding bodies, so recordBodyBlockDeps stayed empty and a bundle that
    // OMITS a signed body_block_cid from its UNAUTHENTICATED pack-table `deps` would be committed
    // (importPack resolves ONLY table deps — packages/lcap/src/pack/import.ts:61) instead of
    // quarantined, and no want would ever be advertised for the gap.  The fix decodes the signed
    // body for unscoped imports too (no public/scope FILTER), so #AC re-quarantines it.
    const lcap = await import('@licio/lcap');
    const hiddenBlock = await cidFor('block', new TextEncoder().encode('omitted body block'));
    const body = lcap.encodeContributionEvent({
      record_version: 2,
      kind: 'contribution_event',
      event_type: 'post',
      home_room_id: 'room-bi',
      visibility_scope: 'public',
      author_account_id: 'a',
      author_device_id: 'd',
      author_device_key_id: 'k',
      device_seq: 1,
      capability_cid: await cidFor('record', new Uint8Array([0])),
      policy_epoch_claim: 0,
      revocation_epoch_claim: 0,
      client_nonce: new Uint8Array([7]),
      priority: 1,
      body_block_cid: hiddenBlock, // referenced in the SIGNED body...
    });
    const recordCid = await cidFor('record', body);
    // ...but the pack-table entry DELIBERATELY omits `deps`, so importPack sees no missing dep and
    // would otherwise commit the record without the block ever being fetched.
    const bundle = writePack({
      objects: [
        {
          cid: recordCid,
          cidKind: 'record',
          frameKind: 'record_body',
          payload: body,
          lane: 'T1',
          priority: 1,
          recordKind: 'contribution_event',
          roomIdHash: new TextEncoder().encode('room-bi'),
          // deps OMITTED on purpose — the unauthenticated table hides the body block dep
        },
      ],
      transportProfile: 'manual_bundle',
      privacyLabel: 'public',
      maxUncompressedBytes: 1 << 20,
    });

    const db2 = await openLcapDb(
      `lcap_v2-bundle-bi-${Math.random().toString(36).slice(2)}`,
      LCAP_DB_VERSION,
      LCAP_MIGRATIONS,
    );
    const read = await readBundleForImport(bundle);
    if (!read.ok) throw new Error('read failed');
    const importResult = await importBundleObjects(read.pack);
    // importPack, seeing no TABLE dep, IMPORTS the record (this is the gap the table hid)...
    expect(importResult.imported.has(recordCid)).toBe(true);
    // ...so the UNSCOPED commit (no roomAllowlist, no publicOnly) must catch the absent body block
    // from the SIGNED body and re-quarantine the record rather than commit it (#BI).
    const counts = await commitImportedBundle(db2, read.pack, importResult);
    expect(counts.records).toBe(0); // held back, NOT committed as renderable
    expect(counts.quarantined).toBe(1);
    expect(counts.missingCids).toContain(hiddenBlock); // the gap is now tracked + advertisable
    db2.close();
  });

  it('SECURITY: an UNSCOPED in_room import re-quarantined on a missing body block is tagged non-public (#BI/#NN)', async () => {
    // The #BI fix enables the re-quarantine loop for unscoped imports — which are NOT public-filtered,
    // so an in_room/private record can land there.  Its quarantine row MUST be tagged public:false so
    // collectQuarantineWants never advertises its missing prerequisite over the PUBLIC courier/WebRTC
    // plane (#NN).  Without the public-flag derivation the row would be public:true and the gap leaks.
    const lcap = await import('@licio/lcap');
    const hiddenBlock = await cidFor('block', new TextEncoder().encode('in-room body block'));
    const body = lcap.encodeContributionEvent({
      record_version: 2,
      kind: 'contribution_event',
      event_type: 'post',
      home_room_id: 'room-bi-inroom',
      visibility_scope: 'in_room', // NON-public — its gaps must stay off the public plane
      author_account_id: 'a',
      author_device_id: 'd',
      author_device_key_id: 'k',
      device_seq: 1,
      capability_cid: await cidFor('record', new Uint8Array([0])),
      policy_epoch_claim: 0,
      revocation_epoch_claim: 0,
      client_nonce: new Uint8Array([8]),
      priority: 1,
      body_block_cid: hiddenBlock,
    });
    const recordCid = await cidFor('record', body);
    const bundle = writePack({
      objects: [
        {
          cid: recordCid,
          cidKind: 'record',
          frameKind: 'record_body',
          payload: body,
          lane: 'T1',
          priority: 1,
          recordKind: 'contribution_event',
          roomIdHash: new TextEncoder().encode('room-bi-inroom'),
          // deps OMITTED — the signed body's block dep is hidden from the unauthenticated table
        },
      ],
      transportProfile: 'manual_bundle',
      privacyLabel: 'contains_in_room_metadata',
      maxUncompressedBytes: 1 << 20,
    });

    const db2 = await openLcapDb(
      `lcap_v2-bundle-bi-nn-${Math.random().toString(36).slice(2)}`,
      LCAP_DB_VERSION,
      LCAP_MIGRATIONS,
    );
    const read = await readBundleForImport(bundle);
    if (!read.ok) throw new Error('read failed');
    const importResult = await importBundleObjects(read.pack);
    const counts = await commitImportedBundle(db2, read.pack, importResult); // UNSCOPED manual import
    expect(counts.quarantined).toBe(1); // re-quarantined on the missing signed-body block (#BI)

    const rows = await collectByCursor<{ cid: string; public?: boolean }>(
      db2,
      LCAP_STORE.quarantine,
    );
    const row = rows.find((r) => r.cid === recordCid);
    expect(row).toBeDefined();
    expect(row?.public).toBe(false); // an in_room gap is NEVER advertised on the public plane (#NN)
    db2.close();
  });
});

describe('bundle import — re-import never downgrades held trust (review)', () => {
  it('reports already-held objects as already_have and preserves their higher trust', async () => {
    // The store already holds this record at `proof_verified` (a higher trust than an
    // import's integrity-only).  Re-importing the SAME bundle must NOT overwrite it back
    // down — trust projection is monotonic (WS-R.8.3).
    const seeded = await seedRecord('room-A', 'held already at higher trust');
    const exportData = await gatherRoomExport(db, 'room-A');
    const disclosure = await exportDisclosure(exportData.items);
    const bundle = await buildBundle({ objects: exportData.objects, disclosure });

    const read = await readBundleForImport(bundle);
    if (!read.ok) throw new Error('read failed');

    const alreadyHave = await heldCidsFor(db, read.pack);
    expect(alreadyHave.has(seeded.recordCid)).toBe(true); // we hold it → it must be skipped
    const result = await importBundleObjects(read.pack, { alreadyHave });
    const counts = await commitImportedBundle(db, read.pack, result);

    expect(counts.records).toBe(0); // nothing re-committed
    expect(counts.alreadyHave).toBeGreaterThanOrEqual(1);

    const stored = await collectByCursor<RecordRow>(db, LCAP_STORE.records);
    const row = stored.find((r) => r.recordCid === seeded.recordCid);
    expect(row?.state).toBe('proof_verified'); // NOT downgraded to integrity_verified
  });

  it('WITHOUT the held set, a naive re-import would downgrade (proves the guard matters)', async () => {
    // Contrast case: a fresh store seeded at proof_verified, re-imported with NO alreadyHave,
    // shows the downgrade the production guard now prevents.
    const db2 = await openLcapDb(
      `lcap_v2-downgrade-${Math.random().toString(36).slice(2)}`,
      LCAP_DB_VERSION,
      LCAP_MIGRATIONS,
    );
    const body = new TextEncoder().encode('downgrade demo');
    const recordCid = await cidFor('record', body);
    const tx = db2.transaction(LCAP_STORE.records, 'readwrite');
    tx.objectStore(LCAP_STORE.records).put({
      recordCid,
      body,
      kind: 'contribution_event',
      lane: 'T1',
      priority: 1,
      roomHash: 'room-A',
      state: 'authorized_provisional',
      size: body.length,
    });
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });

    const bundle = writePack({
      objects: [
        {
          cid: recordCid,
          cidKind: 'record',
          frameKind: 'record_body',
          payload: body,
          lane: 'T1',
          priority: 1,
          recordKind: 'contribution_event',
          roomIdHash: new TextEncoder().encode('room-A'),
        },
      ],
      transportProfile: 'manual_bundle',
      privacyLabel: 'public',
      maxUncompressedBytes: 1 << 20,
    });
    const read = await readBundleForImport(bundle);
    if (!read.ok) throw new Error('read failed');
    // Old buggy call shape: no alreadyHave → re-commits → overwrites the higher trust.
    const result = await importBundleObjects(read.pack);
    await commitImportedBundle(db2, read.pack, result);
    const stored = await collectByCursor<RecordRow>(db2, LCAP_STORE.records);
    expect(stored.find((r) => r.recordCid === recordCid)?.state).toBe('integrity_verified');
    db2.close();
  });
});

describe('bundle import — standalone chunk frames are persisted, not dropped (review)', () => {
  it('persists a CID-verified standalone chunk durably + retrievable by its CID', async () => {
    const recordBody = new TextEncoder().encode('record alongside a chunk');
    const recordCid = await cidFor('record', recordBody);
    const chunkBytes = new TextEncoder().encode('a standalone, CID-verified chunk payload');
    const chunkCid = await cidFor('chunk', chunkBytes);

    const bundle = writePack({
      objects: [
        {
          cid: recordCid,
          cidKind: 'record',
          frameKind: 'record_body',
          payload: recordBody,
          lane: 'T1',
          priority: 1,
          recordKind: 'contribution_event',
          roomIdHash: new TextEncoder().encode('room-A'),
        },
        {
          cid: chunkCid,
          cidKind: 'chunk',
          frameKind: 'chunk',
          payload: chunkBytes,
          lane: 'M3',
          priority: 3,
        },
      ],
      transportProfile: 'manual_bundle',
      privacyLabel: 'public',
      maxUncompressedBytes: 1 << 20,
    });

    const db2 = await openLcapDb(
      `lcap_v2-chunk-${Math.random().toString(36).slice(2)}`,
      LCAP_DB_VERSION,
      LCAP_MIGRATIONS,
    );
    const read = await readBundleForImport(bundle);
    if (!read.ok) throw new Error('read failed');
    expect(read.summary.byKind.chunk).toBe(1);
    const result = await importBundleObjects(read.pack);
    const counts = await commitImportedBundle(db2, read.pack, result);

    expect(counts.records).toBe(1);
    expect(counts.chunks).toBe(1); // the verified chunk is persisted, not silently dropped
    const reassembled = await readBlockBytes(db2, chunkCid); // retrievable by its CID
    expect(reassembled).toBeDefined();
    expect(Array.from(reassembled ?? [])).toEqual(Array.from(chunkBytes)); // byte-for-byte
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
