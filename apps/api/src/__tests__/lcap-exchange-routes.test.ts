// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.4 — the §29.2 `POST /exchange` main bidirectional sync path.  Ingests an
// optional push pack through the SHARED WS-R.4.2 validator (idempotent by
// record_cid → accepted_push), returns the server's pulse (frontiers), and derives
// `wanted_from_client` from the server's own frontier diff against the client's
// advertised frontier.  Exercises the §22.1.1 status mapping (200 / 400 / 422 / 413)
// and the full-app mount (the CSRF-exempt POST passes the global middleware).

import {
  buildExchangeRequest,
  buildPulse,
  cidFor,
  DEFAULT_BUDGET,
  decodeWithSchema,
  detachedProofV2Schema,
  type ExchangeRequestV2,
  encodeWithSchema,
  exchangeRequestV2Schema,
  exchangeResponseV2Schema,
  type RevocationFrontierV2,
  readPack,
  type SyncPulseV2,
  syncPulseV2Schema,
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
  NET,
  NOW,
  registerIdentity,
} from './lcap-fixtures.js';

const enc = new TextEncoder();

let fx: LcapFixtures;
let pushPack: Uint8Array;
let proofBytes: Uint8Array;
let proofCid: string;

beforeAll(async () => {
  fx = await buildLcapFixtures();
  proofBytes = encodeWithSchema(detachedProofV2Schema, fx.proof);
  proofCid = await cidFor('proof', proofBytes);
  pushPack = writePack({
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
    ],
    transportProfile: 'manual_bundle',
    privacyLabel: 'public',
    maxUncompressedBytes: 1_000_000,
  });
});

/** A schema-valid client pulse (optionally with a revocation frontier). */
function clientPulse(revocationFrontier: readonly RevocationFrontierV2[] = []) {
  return buildPulse({
    nodeId: 'client-1',
    sessionNonce: new Uint8Array([1, 2, 3, 4]),
    transportProfile: 'https',
    privacyMode: 'public',
    budgets: DEFAULT_BUDGET,
    supportedSuites: ['ES256'],
    supportedCompression: ['none'],
    supportedPackVersions: [2],
    checkpointFrontier: [],
    revocationFrontier: [...revocationFrontier],
  });
}

function exchangeBytes(over: Partial<Parameters<typeof buildExchangeRequest>[0]> = {}): Uint8Array {
  const request: ExchangeRequestV2 = buildExchangeRequest({
    pulse: clientPulse(),
    interests: [],
    ...over,
  });
  return encodeWithSchema(exchangeRequestV2Schema, request);
}

describe('POST /exchange — §29.2 bidirectional sync', () => {
  it('returns 200 with the server pulse for an exchange carrying no push pack', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    const res = await createLcapRoutes(srv).request('/exchange', {
      method: 'POST',
      body: exchangeBytes(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/cbor');
    const decoded = decodeWithSchema(
      exchangeResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(decoded.status).toBe('ok');
    expect(decoded.pulse.node_id).toBe(`lcap-server:${NET}`);
    expect('accepted_push' in decoded).toBe(false);
  });

  it('ingests the push pack through the shared validator and commits its contribution', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    await registerIdentity(srv, fx);
    const res = await createLcapRoutes(srv).request('/exchange', {
      method: 'POST',
      body: exchangeBytes({ pulse: clientPulse(), interests: [], pushPack }),
    });
    expect(res.status).toBe(200);
    const decoded = decodeWithSchema(
      exchangeResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(decoded.accepted_push).toContainEqual(
      expect.objectContaining({ cid: fx.recordCid, status: 'accepted' }),
    );
    expect(await srv.isAccepted(fx.recordCid)).toBe(true);
    // The freshly-accepted room now carries a checkpoint-frontier entry.
    expect(decoded.pulse.checkpoint_frontier).toHaveLength(1);
  });

  it('is idempotent: re-exchanging the same push pack reports already_have', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    await registerIdentity(srv, fx);
    const body = exchangeBytes({ pulse: clientPulse(), interests: [], pushPack });
    await createLcapRoutes(srv).request('/exchange', { method: 'POST', body });
    const res = await createLcapRoutes(srv).request('/exchange', { method: 'POST', body });
    const decoded = decodeWithSchema(
      exchangeResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(decoded.accepted_push).toContainEqual(
      expect.objectContaining({ cid: fx.recordCid, status: 'already_have' }),
    );
  });

  it('derives wanted_from_client when the client advertises a revocation the server lacks', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    const revCheckpointCid = await cidFor('record', enc.encode('rev-checkpoint-5'));
    const res = await createLcapRoutes(srv).request('/exchange', {
      method: 'POST',
      body: exchangeBytes({
        pulse: clientPulse([
          {
            scope: 'global',
            revocation_epoch: 5,
            latest_revocation_checkpoint_cid: revCheckpointCid,
          },
        ]),
        interests: [],
      }),
    });
    const decoded = decodeWithSchema(
      exchangeResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(decoded.wanted_from_client).toContainEqual(
      expect.objectContaining({ cid: revCheckpointCid, reason: 'revocation_gap' }),
    );
  });

  it('returns 400 for an undecodable body, 422 for a non-exchange shape', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    const undecodable = await createLcapRoutes(srv).request('/exchange', {
      method: 'POST',
      body: new Uint8Array([0xff, 0xff, 0xff]),
    });
    expect(undecodable.status).toBe(400);

    // A bare SyncPulseV2 is valid CBOR but not an ExchangeRequestV2 → 422.
    const notAnExchange = encodeWithSchema(syncPulseV2Schema, clientPulse());
    const semantic = await createLcapRoutes(srv).request('/exchange', {
      method: 'POST',
      body: notAnExchange,
    });
    expect(semantic.status).toBe(422);
  });

  it('returns 413 for an oversized request body', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    const res = await createLcapRoutes(srv).request('/exchange', {
      method: 'POST',
      body: new Uint8Array(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });
});

describe('POST /exchange — §29.2 response_pack (server-push of client wants)', () => {
  it('serves a response_pack of the client wants the server holds, readable back', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    await srv.putObject(fx.recordCid, 'record', fx.body);
    await srv.putObject(proofCid, 'proof', proofBytes);

    const res = await createLcapRoutes(srv).request('/exchange', {
      method: 'POST',
      body: exchangeBytes({
        pulse: clientPulse(),
        interests: [],
        want: [
          { cid: fx.recordCid, cid_kind: 'record', reason: 'explicit_user_request' },
          { cid: proofCid, cid_kind: 'proof', reason: 'explicit_user_request' },
        ],
      }),
    });
    const decoded = decodeWithSchema(
      exchangeResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(decoded.status).toBe('ok');
    expect(decoded.response_pack).toBeDefined();
    const read = await readPack(decoded.response_pack as Uint8Array);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect([...read.pack.frames.keys()].sort()).toEqual([fx.recordCid, proofCid].sort());
    }
  });

  it('marks the exchange partial when a held want is dropped for the response budget', async () => {
    const srv = new LcapIngestServer(NET, () => NOW);
    await srv.putObject(fx.recordCid, 'record', fx.body);
    await srv.putObject(proofCid, 'proof', proofBytes);

    // Measure the REAL serialized size of a one-record response (header + table + CIDs + deps, not a
    // payload estimate — #VV) by serving JUST the record under a generous budget.
    const sizingRes = await createLcapRoutes(srv).request('/exchange', {
      method: 'POST',
      body: exchangeBytes({
        pulse: { ...clientPulse(), budgets: { ...DEFAULT_BUDGET, max_response_bytes: 1_000_000 } },
        interests: [],
        want: [{ cid: fx.recordCid, cid_kind: 'record', reason: 'explicit_user_request' }],
      }),
    });
    const oneRecordBytes = (
      decodeWithSchema(exchangeResponseV2Schema, new Uint8Array(await sizingRes.arrayBuffer()))
        .response_pack as Uint8Array
    ).length;

    // A budget that fits EXACTLY the first want serves one object and drops the proof → partial with
    // a one-object response_pack.  (A budget below even the first object would serve nothing — the
    // first want is not exempt.)
    const tightPulse: SyncPulseV2 = {
      ...clientPulse(),
      budgets: { ...DEFAULT_BUDGET, max_response_bytes: oneRecordBytes },
    };
    const res = await createLcapRoutes(srv).request('/exchange', {
      method: 'POST',
      body: exchangeBytes({
        pulse: tightPulse,
        interests: [],
        want: [
          { cid: fx.recordCid, cid_kind: 'record', reason: 'explicit_user_request' },
          { cid: proofCid, cid_kind: 'proof', reason: 'explicit_user_request' },
        ],
      }),
    });
    const decoded = decodeWithSchema(
      exchangeResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(decoded.status).toBe('partial');
    expect(decoded.response_pack).toBeDefined();
  });
});

describe('mounted at /api/lcap/v2/exchange (CSRF-exempt POST passes the global middleware)', () => {
  it('processes an exchange through the full app and is not blocked with 403', async () => {
    const mounted = new LcapIngestServer(NET, () => NOW);
    await registerIdentity(mounted, fx);
    setLcapIngestServer(mounted);
    const res = await createApp().request('/api/lcap/v2/exchange', {
      method: 'POST',
      body: exchangeBytes({ pulse: clientPulse(), interests: [], pushPack }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
