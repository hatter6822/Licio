// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.4 — the §29 pack-import endpoint (POST /api/lcap/v2/packs).  A real
// `.licio-bundle` carrying a signed contribution + its detached proof + a block is
// read under the WS-R.4.2 caps; every frame is durably stored (so the GET routes
// can serve them) and the contribution is committed through the server's
// validate→guard→commit pipeline.  The endpoint is CSRF-exempt
// (device-cert-authenticated content) and applies the §22.1.1 status mapping.

import { cidFor, detachedProofV2Schema, encodeWithSchema, writePack } from '@licio/lcap';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { LcapIngestServer } from '../lcap/server-ingest.js';
import { setLcapIngestServer } from '../lcap/service.js';
import {
  buildLcapFixtures,
  type LcapFixtures,
  NET,
  NOW,
  registerIdentity,
} from './lcap-fixtures.js';

let fx: LcapFixtures;
let packBytes: Uint8Array;
let proofCid: string;
let blockCid: string;
let blockBytes: Uint8Array;

beforeAll(async () => {
  fx = await buildLcapFixtures();
  const proofBytes = encodeWithSchema(detachedProofV2Schema, fx.proof);
  proofCid = await cidFor('proof', proofBytes);
  blockBytes = new TextEncoder().encode('an-imported-block');
  blockCid = await cidFor('block', blockBytes);
  packBytes = writePack({
    objects: [
      {
        cid: fx.recordCid,
        cidKind: 'record',
        frameKind: 'record_body',
        payload: fx.body,
        lane: 'M3',
        priority: 1,
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

describe('POST /api/lcap/v2/packs — bundle import (WS-R.12.4)', () => {
  it('imports a pack and commits its contribution against pre-registered identity', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    await registerIdentity(srv, fx);
    setLcapIngestServer(srv);

    const res = await createApp().request('/api/lcap/v2/packs', {
      method: 'POST',
      body: packBytes,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { statuses: { cid: string; status: string }[] };
    expect(data.statuses).toContainEqual(
      expect.objectContaining({ cid: fx.recordCid, status: 'accepted' }),
    );
    expect(await srv.isAccepted(fx.recordCid)).toBe(true);
  });

  it('durably stores proof + block frames so they are fetchable via the GET routes', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    await registerIdentity(srv, fx);
    setLcapIngestServer(srv);
    const app = createApp();

    const imported = await app.request('/api/lcap/v2/packs', { method: 'POST', body: packBytes });
    expect(imported.status).toBe(200);
    const data = (await imported.json()) as { statuses: { cid: string; status: string }[] };
    expect(data.statuses).toContainEqual(
      expect.objectContaining({ cid: proofCid, status: 'stored_unverified' }),
    );
    expect(data.statuses).toContainEqual(
      expect.objectContaining({ cid: blockCid, status: 'stored_unverified' }),
    );

    const proofRes = await app.request(`/api/lcap/v2/proofs/${proofCid}`);
    expect(proofRes.status).toBe(200);
    const blockRes = await app.request(`/api/lcap/v2/blocks/${blockCid}`);
    expect(blockRes.status).toBe(200);
    expect(new Uint8Array(await blockRes.arrayBuffer())).toEqual(blockBytes);
  });

  it('quarantines the contribution and wants the capability when identity is unregistered', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    await registerIdentity(srv, fx, { capability: false }); // cert + authority but no capability
    setLcapIngestServer(srv);

    const res = await createApp().request('/api/lcap/v2/packs', {
      method: 'POST',
      body: packBytes,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      statuses: { cid: string; status: string }[];
      wants: { cid: string }[];
    };
    const recordStatus = data.statuses.find((s) => s.cid === fx.recordCid);
    expect(recordStatus?.status).toBe('quarantined_missing_dependency');
    expect(data.wants.some((w) => w.cid === fx.capabilityCid)).toBe(true);
  });

  it('rejects a malformed (non-pack) body as a non-retriable 422', async () => {
    setLcapIngestServer(new LcapIngestServer(NET, () => NOW));
    const res = await createApp().request('/api/lcap/v2/packs', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(res.status).toBe(422);
  });

  it('is CSRF-exempt: the POST is not blocked with 403 for lacking a token', async () => {
    setLcapIngestServer(new LcapIngestServer(NET, () => NOW));
    const res = await createApp().request('/api/lcap/v2/packs', {
      method: 'POST',
      body: new Uint8Array([0]),
    });
    expect(res.status).not.toBe(403);
  });

  it('is idempotent: re-importing the same pack reports already_have for every object', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    await registerIdentity(srv, fx);
    setLcapIngestServer(srv);
    const app = createApp();

    await app.request('/api/lcap/v2/packs', { method: 'POST', body: packBytes }); // first import
    const res = await app.request('/api/lcap/v2/packs', { method: 'POST', body: packBytes }); // again
    expect(res.status).toBe(200);
    const data = (await res.json()) as { statuses: { cid: string; status: string }[] };
    expect(data.statuses.find((s) => s.cid === fx.recordCid)?.status).toBe('already_have');
    expect(data.statuses.find((s) => s.cid === proofCid)?.status).toBe('already_have');
    expect(data.statuses.find((s) => s.cid === blockCid)?.status).toBe('already_have');
  });

  it('reports rejected_bad_cid for a frame whose payload does not match its CID', async () => {
    setLcapIngestServer(new LcapIngestServer(NET, () => NOW));
    const enc = new TextEncoder();
    const declaredCid = await cidFor('block', enc.encode('declared'));
    const badPack = writePack({
      objects: [
        {
          cid: declaredCid, // a valid-format CID …
          cidKind: 'block',
          frameKind: 'block',
          payload: enc.encode('actual-and-different'), // … that does not address this payload
          lane: 'B4',
          priority: 2,
        },
      ],
      transportProfile: 'manual_bundle',
      privacyLabel: 'public',
      maxUncompressedBytes: 1_000_000,
    });

    const res = await createApp().request('/api/lcap/v2/packs', { method: 'POST', body: badPack });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { statuses: { cid: string; status: string }[] };
    expect(data.statuses.find((s) => s.cid === declaredCid)?.status).toBe('rejected_bad_cid');
  });
});
