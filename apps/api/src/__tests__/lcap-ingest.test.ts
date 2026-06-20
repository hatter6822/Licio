// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-memory server LCAP ingestion (WS-R.12.1a/c binding): the commit service over
// the pure `ingestRecord` decision — CID-verified durable store, the per-room
// canonical acceptance log, authoritative idempotency, and server-side fork
// detection.  The §24.2 "never emit before validation" rule is exercised
// end-to-end: only accepted records reach the room log.

import { cidFor, type ValidationResult } from '@licio/lcap';
import { beforeAll, describe, expect, it } from 'vitest';
import { LcapIngestServer } from '../lcap/server-ingest.js';

const enc = new TextEncoder();

const vr = (
  state: ValidationResult['state'],
  over: Omit<ValidationResult, 'state' | 'missingCids' | 'facts'> & {
    missingCids?: readonly string[];
  } = {},
): ValidationResult => ({ state, missingCids: over.missingCids ?? [], facts: {}, ...over });

const ROOM = 'room-1';
const DEVICE = 'device-key-1';

let bodyA: Uint8Array;
let cidA: string;
let bodyB: Uint8Array;
let cidB: string;
let depCid: string;

beforeAll(async () => {
  bodyA = enc.encode('record-A');
  cidA = await cidFor('record', bodyA);
  bodyB = enc.encode('record-B');
  cidB = await cidFor('record', bodyB);
  depCid = await cidFor('record', enc.encode('dependency-1'));
});

describe('LcapIngestServer.commitRecord (§24.1 stages 1+3)', () => {
  it('accepts a clean record: stores it, appends to the room log, marks accepted', async () => {
    const srv = new LcapIngestServer('net');
    const res = await srv.commitRecord({
      recordCid: cidA,
      roomId: ROOM,
      authorDeviceKeyId: DEVICE,
      deviceSeq: 0,
      body: bodyA,
      validation: vr('authorized_provisional'),
    });
    expect(res.status.status).toBe('accepted');
    expect(res.roomSeq).toBe(0);
    expect(res.receiptType).toBe('accepted');
    expect(srv.roomSize(ROOM)).toBe(1);
    expect(srv.isAccepted(cidA)).toBe(true);
  });

  it('is idempotent by record_cid: a re-commit is already_have and never re-appends', async () => {
    const srv = new LcapIngestServer('net');
    const input = {
      recordCid: cidA,
      roomId: ROOM,
      authorDeviceKeyId: DEVICE,
      deviceSeq: 0,
      body: bodyA,
      validation: vr('authorized_provisional'),
    };
    await srv.commitRecord(input);
    const again = await srv.commitRecord(input);
    expect(again.status.status).toBe('already_have');
    expect(again.roomSeq).toBe(0);
    expect(srv.roomSize(ROOM)).toBe(1); // exactly one canonical entry
  });

  it('rejects a record whose body does not match its claimed CID, storing nothing', async () => {
    const srv = new LcapIngestServer('net');
    const res = await srv.commitRecord({
      recordCid: cidA, // claims A's CID …
      roomId: ROOM,
      authorDeviceKeyId: DEVICE,
      deviceSeq: 0,
      body: bodyB, // … but ships B's body
      validation: vr('authorized_provisional'),
    });
    expect(res.status.status).toBe('rejected_bad_cid');
    expect(srv.hasObject(cidA)).toBe(false);
    expect(srv.roomSize(ROOM)).toBe(0);
  });

  it('quarantines a record with unmet dependencies, emitting wants and not appending', async () => {
    const srv = new LcapIngestServer('net');
    const res = await srv.commitRecord({
      recordCid: cidA,
      roomId: ROOM,
      authorDeviceKeyId: DEVICE,
      deviceSeq: 0,
      body: bodyA,
      validation: vr('proof_verified', { missingCids: [depCid] }),
    });
    expect(res.status.status).toBe('quarantined_missing_dependency');
    expect(res.status.missing_cids).toEqual([depCid]);
    expect(res.wants).toEqual([{ cid: depCid, cid_kind: 'record', reason: 'missing_dependency' }]);
    expect(res.receiptType).toBe('quarantined');
    expect(srv.roomSize(ROOM)).toBe(0); // §24.2 — never emitted
    expect(srv.isAccepted(cidA)).toBe(false);
  });

  it('detects a device fork: a distinct CID at an accepted (key, seq) yields fork evidence', async () => {
    const srv = new LcapIngestServer('net');
    await srv.commitRecord({
      recordCid: cidA,
      roomId: ROOM,
      authorDeviceKeyId: DEVICE,
      deviceSeq: 5,
      body: bodyA,
      validation: vr('authorized_provisional'),
    });
    const fork = await srv.commitRecord({
      recordCid: cidB, // different record …
      roomId: ROOM,
      authorDeviceKeyId: DEVICE,
      deviceSeq: 5, // … claiming the same device sequence
      body: bodyB,
      validation: vr('authorized_provisional'),
    });
    expect(fork.status.status).toBe('conflict_device_fork');
    expect(fork.receiptType).toBeUndefined();
    expect(srv.roomSize(ROOM)).toBe(1); // no second canonical record
    expect(srv.getForkEvidence()).toEqual([
      { authorDeviceKeyId: DEVICE, deviceSeq: 5, existingCid: cidA, conflictingCid: cidB },
    ]);
  });

  it('rejects a revoked record without appending it', async () => {
    const srv = new LcapIngestServer('net');
    const res = await srv.commitRecord({
      recordCid: cidA,
      roomId: ROOM,
      authorDeviceKeyId: DEVICE,
      deviceSeq: 0,
      body: bodyA,
      validation: vr('revoked'),
    });
    expect(res.status.status).toBe('rejected_revoked');
    expect(res.receiptType).toBe('rejected');
    expect(srv.roomSize(ROOM)).toBe(0);
  });
});

describe('LcapIngestServer.commitBatch (§24.4 ordered batch ingestion)', () => {
  it('commits a parent before its child even when the child arrives first', async () => {
    const srv = new LcapIngestServer('net');
    const { statuses } = await srv.commitBatch([
      {
        recordCid: cidB,
        roomId: ROOM,
        authorDeviceKeyId: DEVICE,
        deviceSeq: 1,
        body: bodyB,
        validation: vr('authorized_provisional'),
        requires: [cidA],
      },
      {
        recordCid: cidA,
        roomId: ROOM,
        authorDeviceKeyId: DEVICE,
        deviceSeq: 0,
        body: bodyA,
        validation: vr('authorized_provisional'),
      },
    ]);
    // Both accepted; the room log records the parent (seq 0) before the child (seq 1).
    expect(statuses.every((s) => s.status === 'accepted')).toBe(true);
    expect(srv.roomSize(ROOM)).toBe(2);
    expect(srv.isAccepted(cidA)).toBe(true);
    expect(srv.isAccepted(cidB)).toBe(true);
  });

  it('quarantines a record with an absent dependency and surfaces a de-duplicated want', async () => {
    const srv = new LcapIngestServer('net');
    const { statuses, wants } = await srv.commitBatch([
      {
        recordCid: cidB,
        roomId: ROOM,
        authorDeviceKeyId: DEVICE,
        deviceSeq: 1,
        body: bodyB,
        validation: vr('authorized_provisional'),
        requires: [depCid],
      },
    ]);
    expect(statuses[0]?.status).toBe('quarantined_missing_dependency');
    expect(statuses[0]?.missing_cids).toEqual([depCid]);
    expect(wants).toEqual([{ cid: depCid, cid_kind: 'record', reason: 'missing_dependency' }]);
    expect(srv.hasObject(cidB)).toBe(true); // durably stored (stage 1)
    expect(srv.isAccepted(cidB)).toBe(false); // never emitted (§24.2)
  });

  it('rejects records trapped in a declared-dependency cycle as bad schema', async () => {
    const srv = new LcapIngestServer('net');
    const { statuses } = await srv.commitBatch([
      {
        recordCid: cidA,
        roomId: ROOM,
        authorDeviceKeyId: DEVICE,
        deviceSeq: 0,
        body: bodyA,
        validation: vr('authorized_provisional'),
        requires: [cidB],
      },
      {
        recordCid: cidB,
        roomId: ROOM,
        authorDeviceKeyId: DEVICE,
        deviceSeq: 1,
        body: bodyB,
        validation: vr('authorized_provisional'),
        requires: [cidA],
      },
    ]);
    expect(statuses.every((s) => s.status === 'rejected_bad_schema')).toBe(true);
    expect(srv.roomSize(ROOM)).toBe(0);
  });

  it('treats an already-accepted dependency as satisfied across batches', async () => {
    const srv = new LcapIngestServer('net');
    await srv.commitBatch([
      {
        recordCid: cidA,
        roomId: ROOM,
        authorDeviceKeyId: DEVICE,
        deviceSeq: 0,
        body: bodyA,
        validation: vr('authorized_provisional'),
      },
    ]);
    const { statuses } = await srv.commitBatch([
      {
        recordCid: cidB,
        roomId: ROOM,
        authorDeviceKeyId: DEVICE,
        deviceSeq: 1,
        body: bodyB,
        validation: vr('authorized_provisional'),
        requires: [cidA],
      },
    ]);
    expect(statuses[0]?.status).toBe('accepted');
    expect(srv.roomSize(ROOM)).toBe(2);
  });
});
