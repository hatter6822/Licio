// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.4 — the §29.7 room checkpoint / inclusion / consistency reads.  The server
// reconstructs the room's §19.1 RFC 9162 Merkle log from the canonical acceptance
// order and serves the (unsigned) tree head + inclusion/consistency proofs.  The
// tests VERIFY each served proof against an independently-built RoomLog using the
// pure verifiers — so the endpoint is proven correct, not just well-shaped.

import {
  cidFor,
  emptyTreeHash,
  RoomLog,
  type ValidationResult,
  verifyConsistency,
  verifyInclusion,
} from '@licio/lcap';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createLcapRoutes } from '../lcap/routes.js';
import { LcapIngestServer } from '../lcap/server-ingest.js';
import { setLcapIngestServer } from '../lcap/service.js';

const enc = new TextEncoder();
const NET = 'net';
const ROOM = 'room-1';
const accepted: ValidationResult = { state: 'authorized_provisional', missingCids: [], facts: {} };

const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/.{2}/g) ?? []).map((h) => Number.parseInt(h, 16)));
const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

let cids: string[];

/** Commit `count` accepted records into ROOM; return their CIDs in acceptance order. */
async function seedRoom(server: LcapIngestServer, count: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = enc.encode(`rec-${i}`);
    const cid = await cidFor('record', body);
    await server.commitRecord({
      recordCid: cid,
      roomId: ROOM,
      authorDeviceKeyId: `device-${i}`,
      deviceSeq: 0,
      body,
      validation: accepted,
    });
    out.push(cid);
  }
  return out;
}

/** An independent reference log over the same CIDs (the verification oracle). */
async function referenceLog(orderedCids: readonly string[]): Promise<RoomLog> {
  const log = new RoomLog('RFC9162_SHA256', NET);
  for (const cid of orderedCids) await log.append(cid);
  return log;
}

beforeAll(async () => {
  cids = [];
  for (let i = 0; i < 5; i++) cids.push(await cidFor('record', enc.encode(`rec-${i}`)));
});

describe('GET /rooms/:roomId/checkpoint — §29.7 tree head', () => {
  it('returns the current tree size + root matching an independent RoomLog', async () => {
    const srv = new LcapIngestServer(NET);
    await seedRoom(srv, 5);
    const res = await createLcapRoutes(srv).request(`/rooms/${ROOM}/checkpoint`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tree_size: number;
      root_hash: string;
      tree_algorithm: string;
    };
    expect(body.tree_size).toBe(5);
    expect(body.tree_algorithm).toBe('RFC9162_SHA256');
    const ref = await referenceLog(cids);
    expect(body.root_hash).toBe(toHex(await ref.rootAt()));
  });

  it('returns a size-0 head (the empty-tree hash) for an unknown room', async () => {
    const srv = new LcapIngestServer(NET);
    const res = await createLcapRoutes(srv).request('/rooms/never-seen/checkpoint');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tree_size: number; root_hash: string };
    expect(body.tree_size).toBe(0);
    expect(body.root_hash).toBe(toHex(await emptyTreeHash()));
  });
});

describe('GET /rooms/:roomId/proofs/inclusion — §29.7', () => {
  it('serves an inclusion proof that verifies against the tree head', async () => {
    const srv = new LcapIngestServer(NET);
    await seedRoom(srv, 5);
    const app = createLcapRoutes(srv);

    const headRes = await app.request(`/rooms/${ROOM}/checkpoint`);
    const head = (await headRes.json()) as { root_hash: string };
    const root = hexToBytes(head.root_hash);

    const target = cids[2] as string;
    const res = await app.request(`/rooms/${ROOM}/proofs/inclusion?record_cid=${target}`);
    expect(res.status).toBe(200);
    const proof = (await res.json()) as {
      tree_size: number;
      leaf_index: number;
      audit_path: string[];
    };
    expect(proof.leaf_index).toBe(2);

    const ref = await referenceLog(cids);
    const leaf = ref.leafHashAt(2);
    expect(leaf).toBeDefined();
    const ok = await verifyInclusion(
      leaf as Uint8Array,
      proof.leaf_index,
      proof.tree_size,
      proof.audit_path.map(hexToBytes),
      root,
    );
    expect(ok).toBe(true);
  });

  it('returns 404 for a well-formed CID that is not in the room', async () => {
    const srv = new LcapIngestServer(NET);
    await seedRoom(srv, 2);
    const absent = await cidFor('record', enc.encode('not-in-room'));
    const res = await createLcapRoutes(srv).request(
      `/rooms/${ROOM}/proofs/inclusion?record_cid=${absent}`,
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for a missing or malformed record_cid', async () => {
    const srv = new LcapIngestServer(NET);
    await seedRoom(srv, 2);
    const app = createLcapRoutes(srv);
    expect((await app.request(`/rooms/${ROOM}/proofs/inclusion`)).status).toBe(400);
    expect((await app.request(`/rooms/${ROOM}/proofs/inclusion?record_cid=not-a-cid`)).status).toBe(
      400,
    );
  });
});

describe('GET /rooms/:roomId/proofs/consistency — §29.7', () => {
  it('serves a consistency proof that verifies between two prefix sizes', async () => {
    const srv = new LcapIngestServer(NET);
    await seedRoom(srv, 5);
    const res = await createLcapRoutes(srv).request(
      `/rooms/${ROOM}/proofs/consistency?old=2&new=5`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      first_size: number;
      second_size: number;
      proof: string[];
    };
    expect(body.first_size).toBe(2);
    expect(body.second_size).toBe(5);

    const ref = await referenceLog(cids);
    const ok = await verifyConsistency(
      2,
      5,
      body.proof.map(hexToBytes),
      await ref.rootAt(2),
      await ref.rootAt(5),
    );
    expect(ok).toBe(true);
  });

  it('returns 400 for out-of-range or missing sizes', async () => {
    const srv = new LcapIngestServer(NET);
    await seedRoom(srv, 3);
    const app = createLcapRoutes(srv);
    expect((await app.request(`/rooms/${ROOM}/proofs/consistency?old=2`)).status).toBe(400);
    expect((await app.request(`/rooms/${ROOM}/proofs/consistency?old=4&new=5`)).status).toBe(400);
    expect((await app.request(`/rooms/${ROOM}/proofs/consistency?old=3&new=2`)).status).toBe(400);
    expect((await app.request(`/rooms/${ROOM}/proofs/consistency?old=1.5&new=3`)).status).toBe(400);
  });
});

describe('mounted at /api/lcap/v2/rooms/:roomId/* (GET passes the global middleware)', () => {
  it('serves the checkpoint through the full app', async () => {
    const mounted = new LcapIngestServer(NET);
    await seedRoom(mounted, 3);
    setLcapIngestServer(mounted);
    const res = await createApp().request(`/api/lcap/v2/rooms/${ROOM}/checkpoint`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = (await res.json()) as { tree_size: number };
    expect(body.tree_size).toBe(3);
  });
});
