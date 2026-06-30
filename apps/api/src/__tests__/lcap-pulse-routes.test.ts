// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.4 — the §29.1 `POST /pulse` frontier exchange.  Exercises the engine's
// frontier derivation (the §17.2 per-room checkpoint frontier keyed by the shared
// `room_id_hash`, the §17.3 global revocation frontier) and the route's §22.1.1
// status mapping (200 processed / 400 undecodable / 422 schema-invalid / 413
// oversized), plus the mount through the full app (the CSRF-exempt POST passes the
// global middleware).  A client decodes the returned frontiers and runs the local
// diff (`applyPulse`) to learn what it is behind on.

import {
  buildAndSign,
  buildPulse,
  cidFor,
  DEFAULT_BUDGET,
  type DeviceKeyPair,
  decodeWithSchema,
  encodeWithSchema,
  generateDeviceKey,
  pulseResponseV2Schema,
  type RevocationRecordV2,
  readPack,
  revocationRecordV2Schema,
  roomIdHash,
  syncPulseV2Schema,
  type ValidationResult,
} from '@licio/lcap';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createLcapRoutes } from '../lcap/routes.js';
import { LcapIngestServer } from '../lcap/server-ingest.js';
import { setLcapIngestServer } from '../lcap/service.js';
import { buildLcapFixtures, type LcapFixtures } from './lcap-fixtures.js';

const enc = new TextEncoder();
const NET = 'net';
const ROOM = 'room-1';

// A real PUBLIC contribution record — so a critical_want block can be made PUBLIC-servable (the §29
// gate, PUB-API-CORE-1, only serves a block referenced by a public record).
let fx: LcapFixtures;
beforeAll(async () => {
  fx = await buildLcapFixtures();
});

/** Stage a block as PUBLIC-servable: a public record references it (the §29 public-serve gate
 *  resolves the block → its owning public record).  Without this a held block is withheld. */
async function stagePublicBlock(
  srv: LcapIngestServer,
  blockCid: string,
  blockBytes: Uint8Array,
): Promise<void> {
  await srv.putObject(fx.publicRecordCid, 'record', fx.publicBody);
  await srv.putObject(blockCid, 'block', blockBytes);
  await srv.indexRecordEdge(fx.publicRecordCid, blockCid, 'block');
}

const accepted: ValidationResult = { state: 'authorized_provisional', missingCids: [], facts: {} };

/** A schema-valid client pulse (empty frontiers) → canonical LDC bytes. */
function clientPulseBytes(): Uint8Array {
  const pulse = buildPulse({
    nodeId: 'client-1',
    sessionNonce: new Uint8Array([1, 2, 3, 4]),
    transportProfile: 'https',
    privacyMode: 'public',
    budgets: DEFAULT_BUDGET,
    supportedSuites: ['ES256'],
    supportedCompression: ['none'],
    supportedPackVersions: [2],
    checkpointFrontier: [],
    revocationFrontier: [],
  });
  return encodeWithSchema(syncPulseV2Schema, pulse);
}

/** Commit one accepted record into `roomId` so it carries a frontier entry. */
async function seedRoom(server: LcapIngestServer, roomId: string, tag: string): Promise<void> {
  const body = enc.encode(tag);
  await server.commitRecord({
    recordCid: await cidFor('record', body),
    roomId,
    authorDeviceKeyId: `device-${tag}`,
    deviceSeq: 0,
    body,
    validation: accepted,
  });
}

const ACCOUNT = 'acct-1';
const ACCOUNT_SIGNER = 'account-authority-1';

const revocation = (epoch: number, id: string): RevocationRecordV2 => ({
  record_version: 2,
  kind: 'revocation',
  revocation_id: `rev-${id}`,
  revoked_kind: 'device',
  revoked_id: id,
  account_id: ACCOUNT, // account-scoped: the account authority for ACCOUNT signs it
  effective_at_ms: 1_000,
  revocation_epoch: epoch,
});

/** Register the account authority on `server` and index an authority-signed revocation. */
async function indexRevocation(
  server: LcapIngestServer,
  authority: DeviceKeyPair,
  epoch: number,
  id: string,
): Promise<void> {
  const rev = revocation(epoch, id);
  const body = encodeWithSchema(revocationRecordV2Schema, rev);
  const proof = await buildAndSign({
    privateKey: authority.privateKey,
    signerKeyId: ACCOUNT_SIGNER,
    proofKind: 'authority_signature',
    recordKind: 'revocation',
    recordBody: body,
    networkId: NET,
  });
  const status = await server.registerRevocation(rev, body, proof);
  if (status !== 'registered') throw new Error(`revocation not registered: ${status}`);
}

describe('LcapIngestServer frontier derivation (§17.2/§17.3)', () => {
  it('reports one checkpoint-frontier entry per non-empty room, keyed by room_id_hash', async () => {
    const server = new LcapIngestServer(NET);
    await seedRoom(server, ROOM, 'a');
    await seedRoom(server, ROOM, 'b'); // same room → tree size 2
    await seedRoom(server, 'room-2', 'c');

    const frontier = await server.checkpointFrontier();
    expect(frontier).toHaveLength(2);
    const room1Hash = [...(await roomIdHash(NET, ROOM))].join(',');
    const room1 = frontier.find((f) => [...f.room_id_hash].join(',') === room1Hash);
    expect(room1?.latest_tree_size).toBe(2);
    // No checkpoint CID is emitted before checkpoint issuance lands (§17.2 honest signal).
    expect(room1 && 'latest_checkpoint_cid' in room1).toBe(false);
  });

  it('omits rooms with no accepted records from the frontier', async () => {
    const server = new LcapIngestServer(NET);
    expect(await server.checkpointFrontier()).toHaveLength(0);
  });

  it('reports the global revocation epoch (0 by default, the max indexed otherwise)', async () => {
    const server = new LcapIngestServer(NET);
    const authority = await generateDeviceKey();
    server.registerAccountAuthorityKey(ACCOUNT, 1, authority.publicKey, ACCOUNT_SIGNER);
    expect(server.revocationFrontier()).toEqual([{ scope: 'global', revocation_epoch: 0 }]);
    await indexRevocation(server, authority, 3, 'd1');
    await indexRevocation(server, authority, 7, 'd2');
    await indexRevocation(server, authority, 5, 'd3');
    expect(server.revocationFrontier()).toEqual([{ scope: 'global', revocation_epoch: 7 }]);
  });

  it('serverPulse advertises fixed capabilities and the live frontiers', async () => {
    const server = new LcapIngestServer(NET);
    await seedRoom(server, ROOM, 'a');
    const pulse = await server.serverPulse();
    expect(pulse.node_id).toBe(`lcap-server:${NET}`);
    expect(pulse.transport_profile).toBe('https');
    expect(pulse.supported_suites).toEqual(['ES256']);
    expect(pulse.supported_pack_versions).toEqual([2]);
    expect(pulse.checkpoint_frontier).toHaveLength(1);
    expect(pulse.revocation_frontier).toEqual([{ scope: 'global', revocation_epoch: 0 }]);
  });
});

describe('POST /pulse — §29.1 status mapping', () => {
  it('returns 200 with the server pulse (frontiers) for a valid client pulse', async () => {
    const server = new LcapIngestServer(NET);
    await seedRoom(server, ROOM, 'a');
    const res = await createLcapRoutes(server).request('/pulse', {
      method: 'POST',
      body: clientPulseBytes(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/cbor');

    const decoded = decodeWithSchema(
      pulseResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(decoded.pulse.node_id).toBe(`lcap-server:${NET}`);
    expect(decoded.pulse.checkpoint_frontier).toHaveLength(1);
    expect(decoded.pulse.checkpoint_frontier[0]?.latest_tree_size).toBe(1);
    // This client advertised no critical_want, so no inline critical pack is built.
    expect('critical_pack' in decoded).toBe(false);
  });

  it('returns 400 for an undecodable body (malformed framing, §22.1.1)', async () => {
    const server = new LcapIngestServer(NET);
    const res = await createLcapRoutes(server).request('/pulse', {
      method: 'POST',
      body: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    });
    expect(res.status).toBe(400);
  });

  it('returns 422 for a decodable body that fails the pulse schema (semantic)', async () => {
    const server = new LcapIngestServer(NET);
    // A valid CBOR map that is a PulseResponseV2 (a `{pulse}` envelope), NOT a bare
    // SyncPulseV2 — it decodes structurally but the strict pulse schema rejects it.
    const wrongShape = encodeWithSchema(pulseResponseV2Schema, {
      pulse: await server.serverPulse(),
    });
    const res = await createLcapRoutes(server).request('/pulse', {
      method: 'POST',
      body: wrongShape,
    });
    expect(res.status).toBe(422);
  });

  it('returns 413 for an oversized request body', async () => {
    const server = new LcapIngestServer(NET);
    const huge = new Uint8Array(256 * 1024 + 1);
    const res = await createLcapRoutes(server).request('/pulse', {
      method: 'POST',
      body: huge,
    });
    expect(res.status).toBe(413);
  });
});

describe('POST /pulse — §29.1 critical_pack (C0 server-push)', () => {
  /** A client pulse advertising `criticalWant`, encoded. */
  function pulseWantingBytes(criticalWant: readonly string[]): Uint8Array {
    return encodeWithSchema(
      syncPulseV2Schema,
      buildPulse({
        nodeId: 'client-1',
        sessionNonce: new Uint8Array([1, 2, 3, 4]),
        transportProfile: 'https',
        privacyMode: 'public',
        budgets: DEFAULT_BUDGET,
        supportedSuites: ['ES256'],
        supportedCompression: ['none'],
        supportedPackVersions: [2],
        checkpointFrontier: [],
        revocationFrontier: [],
        criticalWant: [...criticalWant],
      }),
    );
  }

  it('returns an inline critical_pack of the critical_want objects the server holds', async () => {
    const srv = new LcapIngestServer(NET);
    const blockBytes = enc.encode('c0-critical-block');
    const blockCid = await cidFor('block', blockBytes);
    await stagePublicBlock(srv, blockCid, blockBytes);

    const res = await createLcapRoutes(srv).request('/pulse', {
      method: 'POST',
      body: pulseWantingBytes([blockCid]),
    });
    expect(res.status).toBe(200);
    const decoded = decodeWithSchema(
      pulseResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(decoded.critical_pack).toBeDefined();
    const read = await readPack(decoded.critical_pack as Uint8Array);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.pack.frames.has(blockCid)).toBe(true);
  });

  it('NEVER bundles a non-public block into the critical_pack (PUB-API-CORE-1)', async () => {
    const srv = new LcapIngestServer(NET);
    const blockBytes = enc.encode('in-room-media-block');
    const blockCid = await cidFor('block', blockBytes);
    // Held + referenced ONLY by the in_room contribution → not public-servable.
    await srv.putObject(fx.recordCid, 'record', fx.body);
    await srv.putObject(blockCid, 'block', blockBytes);
    await srv.indexRecordEdge(fx.recordCid, blockCid, 'block');

    const res = await createLcapRoutes(srv).request('/pulse', {
      method: 'POST',
      body: pulseWantingBytes([blockCid]),
    });
    const decoded = decodeWithSchema(
      pulseResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    // The in_room block is filtered before repack ⇒ no critical_pack.
    expect('critical_pack' in decoded).toBe(false);
  });

  it('clamps the critical_pack to the client-advertised budget, not the 64KB C0 max', async () => {
    const srv = new LcapIngestServer(NET);
    const blockBytes = enc.encode('a small C0 block — fits the 64KB cap but not a 1-byte budget');
    const blockCid = await cidFor('block', blockBytes);
    await stagePublicBlock(srv, blockCid, blockBytes); // public-servable, so the BUDGET (not the gate) is under test
    // A tiny advertised response budget: with the clamp, the held block (which would fit
    // the 64KB C0 cap) does NOT fit this budget, so no critical_pack is returned (it stays
    // fetchable via the GET routes) — proving the server honours the peer's budget.
    const pulse = encodeWithSchema(
      syncPulseV2Schema,
      buildPulse({
        nodeId: 'client-1',
        sessionNonce: new Uint8Array([1, 2, 3, 4]),
        transportProfile: 'https',
        privacyMode: 'public',
        budgets: { ...DEFAULT_BUDGET, max_response_bytes: 1 },
        supportedSuites: ['ES256'],
        supportedCompression: ['none'],
        supportedPackVersions: [2],
        checkpointFrontier: [],
        revocationFrontier: [],
        criticalWant: [blockCid],
      }),
    );
    const res = await createLcapRoutes(srv).request('/pulse', { method: 'POST', body: pulse });
    const decoded = decodeWithSchema(
      pulseResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect('critical_pack' in decoded).toBe(false);
  });

  it('omits critical_pack when the server holds none of the critical_want', async () => {
    const srv = new LcapIngestServer(NET);
    const absent = await cidFor('block', enc.encode('absent-block'));
    const res = await createLcapRoutes(srv).request('/pulse', {
      method: 'POST',
      body: pulseWantingBytes([absent]),
    });
    const decoded = decodeWithSchema(
      pulseResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect('critical_pack' in decoded).toBe(false);
  });

  it('rejects a CHUNKED (no Content-Length) over-limit body with 413, never buffering it (PUB-API-CORE-2)', async () => {
    const srv = new LcapIngestServer(NET);
    // A STREAMED body with NO Content-Length header — the case `declaredLengthExceeds` cannot catch.
    // It emits far more than the 256 KiB pulse cap; `bodyLimit` must abort it at 413 BEFORE the
    // handler materializes the whole stream (no unbounded buffer, no 500).
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 32 * 1024 * 1024) {
          controller.close(); // a fully-drained stream would reach 32 MiB
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.length;
      },
    });
    const res = await createLcapRoutes(srv).request('/pulse', {
      method: 'POST',
      body,
      // `duplex` is required by the Fetch spec when the body is a stream.
      duplex: 'half',
    });
    expect(res.status).toBe(413);
    // The defining property: bodyLimit aborted EARLY — it did NOT drain the 32 MiB stream into memory
    // before rejecting (the chunked-DoS the old Content-Length-only guard could not stop).
    expect(sent).toBeLessThan(2 * 1024 * 1024);
  });
});

describe('mounted at /api/lcap/v2/pulse (CSRF-exempt POST passes the global middleware)', () => {
  it('processes a pulse through the full app and returns 200', async () => {
    const mounted = new LcapIngestServer(NET);
    await seedRoom(mounted, ROOM, 'mounted');
    setLcapIngestServer(mounted);

    const app = createApp();
    const res = await app.request('/api/lcap/v2/pulse', {
      method: 'POST',
      body: clientPulseBytes(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const decoded = decodeWithSchema(
      pulseResponseV2Schema,
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(decoded.pulse.checkpoint_frontier).toHaveLength(1);
  });
});
