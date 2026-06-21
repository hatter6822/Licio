// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.4 — the packfile / `.licio-bundle` format: streaming write/read with the
// table-before-frames layout, resource caps, per-frame CID verification, partial
// import + quarantine, and the bundle manifest (preparer auth ≠ content trust).

import { describe, expect, it } from 'vitest';
import { cidFor } from '../cid/index.js';
import { generateDeviceKey } from '../cose/keys.js';
import {
  BUNDLE_EXTENSION,
  genericBundleFilename,
  importPack,
  PACK_MAGIC,
  type PackObject,
  readPack,
  readUvarint,
  signManifest,
  verifyManifest,
  writePack,
  writeUvarint,
} from '../pack/index.js';

const CAPS = {
  maxPackBytes: 1 << 20,
  maxHeaderBytes: 1 << 16,
  maxTableBytes: 1 << 18,
  maxFrameHeaderBytes: 4096,
  maxFramePayloadBytes: 1 << 16,
  maxEntries: 1000,
};

async function obj(
  kind: 'record_body' | 'proof' | 'block' | 'chunk',
  payload: Uint8Array,
  over: Partial<PackObject> = {},
): Promise<PackObject> {
  const cidKind = kind === 'record_body' ? 'record' : kind;
  return {
    cid: await cidFor(cidKind, payload),
    cidKind,
    frameKind: kind,
    payload,
    lane: cidKind === 'chunk' ? 'M3' : 'T1',
    priority: cidKind === 'chunk' ? 3 : 1,
    ...over,
  };
}

describe('uvarint', () => {
  it('round-trips a range of values', () => {
    for (const v of [0, 1, 127, 128, 16383, 16384, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      const bytes = writeUvarint(v);
      expect(readUvarint(bytes, 0)).toEqual({ value: v, bytesRead: bytes.length });
    }
  });
});

describe('writer + reader (WS-R.4.1/4.2)', () => {
  it('writes magic-first with the table before frames and round-trips', async () => {
    const objects = [
      await obj('record_body', new TextEncoder().encode('event-record-body')),
      await obj('block', new TextEncoder().encode('the body text')),
      await obj('chunk', new Uint8Array(1000).fill(7)),
    ];
    const pack = writePack({
      objects,
      transportProfile: 'manual_bundle',
      privacyLabel: 'public',
      maxUncompressedBytes: 1 << 20,
    });
    expect(pack.slice(0, PACK_MAGIC.length)).toEqual(PACK_MAGIC);

    const read = await readPack(pack, CAPS);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.pack.entries.map((e) => e.cid)).toEqual(objects.map((o) => o.cid));
    // Offsets are strictly increasing → the frames follow the table in order.
    const offsets = read.pack.entries.map((e) => e.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    for (const object of objects) {
      const frame = read.pack.frames.get(object.cid);
      expect(frame?.cidVerified).toBe(true);
      expect(frame?.payload).toEqual(object.payload);
    }
  });

  it('carries a per-object room_id_hash through the table for pre-read routing', async () => {
    const roomIdHash = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const inRoom = await obj('record_body', new TextEncoder().encode('in-room record'), {
      roomIdHash,
    });
    // A control object with no room: account-scoped, omits room_id_hash.
    const control = await obj('record_body', new TextEncoder().encode('account control'), {
      lane: 'C0',
      priority: 0,
    });
    const pack = writePack({
      objects: [inRoom, control],
      transportProfile: 'manual_bundle',
      privacyLabel: 'public',
      maxUncompressedBytes: 1 << 20,
    });
    const read = await readPack(pack, CAPS);
    if (!read.ok) throw new Error('read failed');
    const byCid = new Map(read.pack.entries.map((e) => [e.cid, e]));
    // The room-bearing record's hash round-trips byte-for-byte; the control omits it.
    expect(byCid.get(inRoom.cid)?.room_id_hash).toEqual(roomIdHash);
    expect(byCid.get(control.cid)?.room_id_hash).toBeUndefined();
  });

  it('honors caps and rejects bad magic / truncation', async () => {
    const objects = [await obj('block', new Uint8Array(5000).fill(1))];
    const pack = writePack({
      objects,
      transportProfile: 'test',
      privacyLabel: 'public',
      maxUncompressedBytes: 1 << 20,
    });
    // Oversized frame payload vs a tiny cap.
    const tight = await readPack(pack, { ...CAPS, maxFramePayloadBytes: 1000 });
    expect(tight).toEqual({ ok: false, status: 'oversized_frame' });
    // Bad magic.
    const corrupt = Uint8Array.from(pack);
    corrupt[0] = 0;
    expect(await readPack(corrupt, CAPS)).toEqual({ ok: false, status: 'bad_magic' });
    // Truncated.
    expect((await readPack(pack.slice(0, pack.length - 10), CAPS)).ok).toBe(false);
  });

  it('flags a frame whose payload does not match its declared CID', async () => {
    const wrongCid = await cidFor('record', new Uint8Array([99]));
    const tampered: PackObject = {
      cid: wrongCid,
      cidKind: 'record',
      frameKind: 'record_body',
      payload: new TextEncoder().encode('not the body for that cid'),
      lane: 'T1',
      priority: 1,
    };
    const pack = writePack({
      objects: [tampered],
      transportProfile: 'test',
      privacyLabel: 'public',
      maxUncompressedBytes: 1 << 20,
    });
    const read = await readPack(pack, CAPS);
    if (!read.ok) throw new Error('read failed');
    expect(read.pack.frames.get(wrongCid)?.cidVerified).toBe(false);
    const { statuses } = importPack(read.pack);
    expect(statuses[0]?.status).toBe('rejected_bad_cid');
  });
});

describe('partial import + quarantine (WS-R.4.3)', () => {
  it('imports the core and skips media chunks', async () => {
    const objects = [
      await obj('record_body', new TextEncoder().encode('event')),
      await obj('block', new TextEncoder().encode('text'), { lane: 'T1', priority: 1 }),
      await obj('chunk', new Uint8Array(2000).fill(9)),
    ];
    const pack = writePack({
      objects,
      transportProfile: 'manual_bundle',
      privacyLabel: 'public',
      maxUncompressedBytes: 1 << 20,
    });
    const read = await readPack(pack, CAPS);
    if (!read.ok) throw new Error('read failed');
    const { statuses, imported } = importPack(read.pack, { skipMedia: true });
    const byCid = new Map(statuses.map((s) => [s.cid, s.status]));
    expect(byCid.get(objects[2]?.cid as string)).toBe('stored_pending'); // chunk skipped
    expect(imported.has(objects[0]?.cid as string)).toBe(true); // record imported
    expect(imported.has(objects[2]?.cid as string)).toBe(false); // media not imported
  });

  it('quarantines a missing dependency and promotes it once supplied', async () => {
    const capCid = await cidFor('record', new TextEncoder().encode('capability-body'));
    const post = await obj('record_body', new TextEncoder().encode('post-needs-cap'), {
      deps: [capCid],
    });
    const pack = writePack({
      objects: [post],
      transportProfile: 'test',
      privacyLabel: 'public',
      maxUncompressedBytes: 1 << 20,
    });
    const read = await readPack(pack, CAPS);
    if (!read.ok) throw new Error('read failed');

    const first = importPack(read.pack);
    expect(first.statuses[0]).toMatchObject({
      status: 'quarantined_missing_dependency',
      missing_cids: [capCid],
    });
    expect(first.imported.size).toBe(0);

    // The dependency arrives → re-import promotes the quarantined record.
    const second = importPack(read.pack, { alreadyHave: new Set([capCid]) });
    expect(second.statuses[0]?.status).toBe('stored_unverified');
    expect(second.imported.has(post.cid)).toBe(true);
  });
});

describe('bundle manifest (WS-R.4.4)', () => {
  it('authenticates the preparer only (manifest ≠ content trust)', async () => {
    const preparer = await generateDeviceKey();
    const entryCid = await cidFor('record', new Uint8Array([1]));
    const bundle = await signManifest({
      preparerPrivateKey: preparer.privateKey,
      preparerSignerKeyId: 'preparer-1',
      manifest: {
        record_version: 2,
        kind: 'bundle_manifest',
        purpose: 'manual_export',
        entries: [
          { cid: entryCid, cid_kind: 'record', lane: 'T1', priority: 1, offset: 0, length: 10 },
        ],
      },
      networkId: 'prod',
    });
    const ok = await verifyManifest(bundle, preparer.publicKey, { networkId: 'prod' });
    expect(ok).toEqual({ ok: true, preparerKeyId: 'preparer-1' });
    // The verification result carries only the preparer identity — it does NOT
    // confer trust on the entries (those still pass `validate`).
    expect(Object.keys(ok)).toEqual(['ok', 'preparerKeyId']);
    // A forged preparer key fails.
    const forged = await generateDeviceKey();
    expect((await verifyManifest(bundle, forged.publicKey, { networkId: 'prod' })).ok).toBe(false);
  });

  it('offers a room/topic-free generic filename', () => {
    const name = genericBundleFilename('2026');
    expect(name.endsWith(BUNDLE_EXTENSION)).toBe(true);
    expect(name).toBe('export-2026.licio-bundle');
  });
});
