// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.4 — the §29.8 bundle EXPORT endpoint (GET /api/lcap/v2/bundles/export).
// A room's content closure (accepted records + each record's proofs + referenced
// blocks) is gathered via the import-captured record→proof/record→block index and
// repacked from held bytes.  Proven by a round trip: import a pack → export the room
// → re-read the exported pack and confirm the full closure is present + re-importable.

import {
  BUNDLE_MIME,
  cidFor,
  detachedProofV2Schema,
  encodeWithSchema,
  generateDeviceKey,
  readPack,
  writePack,
} from '@licio/lcap';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createLcapRoutes } from '../lcap/routes.js';
import { LcapIngestServer } from '../lcap/server-ingest.js';
import { setLcapIngestServer } from '../lcap/service.js';
import {
  buildLcapFixtures,
  type LcapFixtures,
  mintExportRequest,
  NET,
  NOW,
  ROOM,
  registerIdentity,
} from './lcap-fixtures.js';

/** POST an export request envelope to the export route. */
async function postExport(srv: LcapIngestServer, envelope: Uint8Array): Promise<Response> {
  return createLcapRoutes(srv).request('/bundles/export', { method: 'POST', body: envelope });
}

const enc = new TextEncoder();

let fx: LcapFixtures;
let proofBytes: Uint8Array;
let proofCid: string;
let blockBytes: Uint8Array;
let blockCid: string;
let pack: Uint8Array;

beforeAll(async () => {
  fx = await buildLcapFixtures();
  proofBytes = encodeWithSchema(detachedProofV2Schema, fx.proof);
  proofCid = await cidFor('proof', proofBytes);
  blockBytes = enc.encode('export-block-payload');
  blockCid = await cidFor('block', blockBytes);
  // The contribution declares the block as a dep, so the export closure includes it.
  pack = writePack({
    objects: [
      {
        cid: fx.recordCid,
        cidKind: 'record',
        frameKind: 'record_body',
        payload: fx.body,
        lane: 'M3',
        priority: 1,
        deps: [blockCid],
      },
      {
        cid: proofCid,
        cidKind: 'proof',
        frameKind: 'proof',
        payload: proofBytes,
        lane: 'T1',
        priority: 1,
        providesProofFor: fx.recordCid,
      },
      {
        cid: blockCid,
        cidKind: 'block',
        frameKind: 'block',
        payload: blockBytes,
        lane: 'B4',
        priority: 2,
      },
    ],
    transportProfile: 'manual_bundle',
    privacyLabel: 'public',
    maxUncompressedBytes: 1_000_000,
  });
});

async function importedServer(): Promise<LcapIngestServer> {
  const srv = new LcapIngestServer(NET, () => NOW);
  await registerIdentity(srv, fx);
  const res = await createLcapRoutes(srv).request('/packs', { method: 'POST', body: pack });
  expect(res.status).toBe(200);
  expect(await srv.isAccepted(fx.recordCid)).toBe(true);
  return srv;
}

describe('POST /bundles/export — §29.8 capability-gated room content closure (#5)', () => {
  it("exports the room's record + proof + block closure when authorized, re-importable", async () => {
    const srv = await importedServer();
    const res = await postExport(srv, await mintExportRequest(fx));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(BUNDLE_MIME);
    expect(res.headers.get('content-disposition')).toContain('.licio-bundle');

    const exported = await readPack(new Uint8Array(await res.arrayBuffer()));
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const cids = [...exported.pack.frames.keys()];
    expect(cids).toContain(fx.recordCid);
    expect(cids).toContain(proofCid);
    expect(cids).toContain(blockCid);
    // Every exported frame is CID-verified by the reader (the export is re-importable).
    for (const frame of exported.pack.frames.values()) expect(frame.cidVerified).toBe(true);
  });

  it('orders each record immediately before its proofs and blocks', async () => {
    const srv = await importedServer();
    const cids = await srv.exportRoomClosureCids(ROOM);
    expect(cids[0]).toBe(fx.recordCid);
    expect(cids).toEqual([fx.recordCid, proofCid, blockCid]);
  });

  it('rejects an unsigned/malformed export request with 400', async () => {
    const srv = await importedServer();
    const res = await postExport(srv, new Uint8Array([1, 2, 3, 4]));
    expect(res.status).toBe(400);
  });

  it('forbids a forged-signature export request with 403 (the gate)', async () => {
    const srv = await importedServer();
    // The request claims the certified device key id but is signed by an imposter.
    const imposter = await generateDeviceKey();
    const forged = await mintExportRequest(fx, { signer: imposter });
    const res = await postExport(srv, forged);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason?: string }).reason).toBe('rejected_bad_signature');
  });

  it('forbids a stale (outside the freshness window) export request with 403', async () => {
    const srv = await importedServer();
    const stale = await mintExportRequest(fx, { issuedAtMs: NOW - 10 * 60_000 });
    const res = await postExport(srv, stale);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason?: string }).reason).toBe('rejected_stale_request');
  });

  it('forbids a request whose capability is not registered with 403', async () => {
    const srv = await importedServer();
    const unknownCap = await cidFor('record', enc.encode('not-a-registered-capability'));
    const res = await postExport(srv, await mintExportRequest(fx, { capabilityCid: unknownCap }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason?: string }).reason).toBe('rejected_unknown_capability');
  });

  it('forbids a request for a room the capability does not cover with 403', async () => {
    const srv = await importedServer();
    // The capability is for ROOM; ask to export a different room with it.
    const res = await postExport(srv, await mintExportRequest(fx, { roomId: 'some-other-room' }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason?: string }).reason).toBe('rejected_room_mismatch');
  });
});

describe('mounted at /api/lcap/v2/bundles/export (CSRF-exempt device-authenticated POST)', () => {
  it('serves an authorized export through the full app', async () => {
    setLcapIngestServer(await importedServer());
    const res = await createApp().request('/api/lcap/v2/bundles/export', {
      method: 'POST',
      body: await mintExportRequest(fx),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(BUNDLE_MIME);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('still forbids an unauthorized export through the full app (gate enforced end-to-end)', async () => {
    setLcapIngestServer(await importedServer());
    const imposter = await generateDeviceKey();
    const res = await createApp().request('/api/lcap/v2/bundles/export', {
      method: 'POST',
      body: await mintExportRequest(fx, { signer: imposter }),
    });
    expect(res.status).toBe(403);
  });
});
