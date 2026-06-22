// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.9.2b / WS-R.12.1c — SERVER-SIDE checkpoint issuance.  The node, acting as the
// room authority, issues a signed `room_checkpoint` over its canonical acceptance log
// on the maintenance tick.  These tests prove the issued checkpoint VERIFIES against the
// room authority key + matches an independently-built RoomLog, is idempotent by tree
// size, chains via `previous_checkpoint_cid`, surfaces in the §17.2 frontier, and is
// served by the §29.7 route — so the server's checkpoint is proven correct, not stubbed.

import {
  cidFor,
  decodeWithSchema,
  detachedProofV2Schema,
  roomCheckpointRecordV2Schema,
  verifyCheckpoint,
} from '@licio/lcap';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLcapRoutes } from '../lcap/routes.js';
import { runLcapTick, startLcapScheduler } from '../lcap/scheduler.js';
import { LcapIngestServer } from '../lcap/server-ingest.js';
import {
  buildLcapFixtures,
  DEVICE_KEY,
  type LcapFixtures,
  mintContribution,
  NET,
  NOW,
  POLICY_EPOCH,
  ROOM,
  ROOM_AUTHORITY_SIGNER,
  registerIdentity,
} from './lcap-fixtures.js';

let fx: LcapFixtures;

beforeAll(async () => {
  fx = await buildLcapFixtures();
});

/** A server with identity registered AND the room-authority SIGNING key for issuance. */
async function issuingServer(): Promise<LcapIngestServer> {
  const srv = new LcapIngestServer(NET, () => NOW);
  await registerIdentity(srv, fx);
  srv.registerRoomAuthoritySigner(
    ROOM,
    POLICY_EPOCH,
    fx.roomAuthority.privateKey,
    ROOM_AUTHORITY_SIGNER,
  );
  return srv;
}

/** Commit a contribution at `deviceSeq` so the room log grows by one. */
async function commit(
  srv: LcapIngestServer,
  deviceSeq: number,
  prevDeviceRecordCid?: string,
): Promise<string> {
  const e = await mintContribution(fx, {
    deviceSeq,
    capabilityCid: fx.capabilityCid,
    ...(prevDeviceRecordCid !== undefined ? { prevDeviceRecordCid } : {}),
  });
  const res = await srv.commitRecord({
    recordCid: e.recordCid,
    roomId: ROOM,
    authorDeviceKeyId: DEVICE_KEY,
    deviceSeq,
    capabilityCid: fx.capabilityCid,
    body: e.body,
    proofs: [e.proof],
  });
  expect(res.status.status).toBe('accepted');
  return e.recordCid;
}

describe('LcapIngestServer — server-side checkpoint issuance (WS-R.9.2b / 12.1c)', () => {
  it('issues a checkpoint that verifies against the room authority key and matches the log', async () => {
    const srv = await issuingServer();
    await commit(srv, 0);

    const bundle = await srv.issueCheckpoint(ROOM);
    expect(bundle).toBeDefined();
    if (!bundle) return;
    expect(bundle.checkpoint.tree_size).toBe(1);
    expect(bundle.checkpoint.room_id).toBe(ROOM);
    expect(bundle.checkpoint.signer_authority_id).toBe(ROOM_AUTHORITY_SIGNER);
    expect(bundle.checkpoint.previous_checkpoint_cid).toBeUndefined();

    // The authority proof verifies against the room authority PUBLIC key.
    const verified = await verifyCheckpoint(bundle, fx.roomAuthority.publicKey, { networkId: NET });
    expect(verified.ok).toBe(true);

    // The merkle_root equals the server's own (independently-recomputed) tree-head root.
    const head = await srv.roomTreeHead(ROOM);
    expect(bundle.checkpoint.merkle_root).toEqual(head.rootHash);

    // The checkpoint body + its proof are durably stored (fetchable by CID, §29).
    const cid = await cidFor('record', bundle.body);
    expect(await srv.hasObject(cid)).toBe(true);
  });

  it('is idempotent at an unchanged tree size, then chains the next checkpoint', async () => {
    const srv = await issuingServer();
    const e0 = await commit(srv, 0);
    const first = await srv.issueCheckpoint(ROOM);
    const firstCid = await cidFor('record', (first as NonNullable<typeof first>).body);

    // Re-issue with no new content → the SAME checkpoint (no churn).
    const again = await srv.issueCheckpoint(ROOM);
    expect(again && (await cidFor('record', again.body))).toBe(firstCid);

    // Grow the log, then re-issue → a NEW checkpoint chaining the previous one.
    await commit(srv, 1, e0);
    const second = await srv.issueCheckpoint(ROOM);
    expect(second).toBeDefined();
    if (!second) return;
    expect(second.checkpoint.tree_size).toBe(2);
    expect(second.checkpoint.previous_checkpoint_cid).toBe(firstCid);
  });

  it('returns undefined for a room with no signer or an empty log', async () => {
    // No signer registered → never issues (this node is not authoritative for the room).
    const noSigner = new LcapIngestServer(NET, () => NOW);
    await registerIdentity(noSigner, fx);
    await commit(noSigner, 0);
    expect(await noSigner.issueCheckpoint(ROOM)).toBeUndefined();

    // Signer present but the room is empty → nothing to attest.
    const empty = await issuingServer();
    expect(await empty.issueCheckpoint(ROOM)).toBeUndefined();
  });

  it('surfaces the latest checkpoint CID in the §17.2 frontier after issuance', async () => {
    const srv = await issuingServer();
    await commit(srv, 0);
    const before = await srv.checkpointFrontier();
    expect(before.find((f) => f.latest_checkpoint_cid !== undefined)).toBeUndefined();

    const bundle = await srv.issueCheckpoint(ROOM);
    const cid = await cidFor('record', (bundle as NonNullable<typeof bundle>).body);
    const after = await srv.checkpointFrontier();
    expect(after.some((f) => f.latest_checkpoint_cid === cid)).toBe(true);
  });

  it('issues for every grown room on the maintenance tick (idempotent next tick)', async () => {
    const srv = await issuingServer();
    await commit(srv, 0);
    const issued = await runLcapTick(srv);
    expect(issued).toEqual([ROOM]);
    // A second tick with no new content issues nothing (idempotent).
    expect(await runLcapTick(srv)).toEqual([]);
  });

  it('the hourly scheduler runs an immediate tick that issues checkpoints', async () => {
    const srv = await issuingServer();
    await commit(srv, 0);
    // No runner ⇒ no lease gate; the immediate tick issues the checkpoint.
    const stop = startLcapScheduler(srv, () => undefined);
    try {
      await vi.waitFor(() => expect(srv.latestCheckpoint(ROOM)).toBeDefined());
    } finally {
      stop();
    }
  });

  it('serves the signed checkpoint wire form (record body + proof, both decodable)', async () => {
    const srv = await issuingServer();
    await commit(srv, 0);
    await srv.issueCheckpoint(ROOM);

    const wire = await srv.latestCheckpointWire(ROOM);
    expect(wire).toBeDefined();
    if (!wire) return;
    // The wire record body decodes to a room_checkpoint; the proof body decodes to a proof.
    const checkpoint = decodeWithSchema(roomCheckpointRecordV2Schema, wire.recordBody);
    expect(checkpoint.kind).toBe('room_checkpoint');
    expect(checkpoint.tree_size).toBe(1);
    const proof = decodeWithSchema(detachedProofV2Schema, wire.proofBody);
    expect(proof.record_kind).toBe('room_checkpoint');
    // The wire CIDs are the real content addresses.
    expect(wire.cid).toBe(await cidFor('record', wire.recordBody));
    expect(wire.proofCid).toBe(await cidFor('proof', wire.proofBody));
  });

  it('§29.7 GET /rooms/:id/checkpoint serves the unsigned head AND the signed checkpoint', async () => {
    const srv = await issuingServer();
    await commit(srv, 0);

    // Before issuance: the head, no `checkpoint` field.
    const head = await createLcapRoutes(srv).request(`/rooms/${ROOM}/checkpoint`);
    expect(head.status).toBe(200);
    const headBody = (await head.json()) as { tree_size: number; checkpoint?: unknown };
    expect(headBody.tree_size).toBe(1);
    expect(headBody.checkpoint).toBeUndefined();

    // After issuance: the same head PLUS the signed checkpoint (record + proof, CID-addressed).
    await srv.issueCheckpoint(ROOM);
    const res = await createLcapRoutes(srv).request(`/rooms/${ROOM}/checkpoint`);
    const body = (await res.json()) as {
      tree_size: number;
      checkpoint?: { cid: string; record_body: string; proof_cid: string; proof_body: string };
    };
    expect(body.checkpoint).toBeDefined();
    expect(body.checkpoint?.cid).toMatch(/^lcapr_/);
    expect(body.checkpoint?.proof_cid).toMatch(/^lcapp_/);
    expect(body.checkpoint?.record_body).toMatch(/^[0-9a-f]+$/);
    expect(body.checkpoint?.proof_body.length).toBeGreaterThan(0);
  });
});
