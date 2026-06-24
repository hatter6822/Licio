// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the rendezvous-cap reducer ops (docs/private-p2p/TIER2-RENDEZVOUS-CAP.md
// §11). A device self-publishes its blind credential commitment (`rendezvous.request` →
// the device's `rendezvousCommitment`, converged + snapshotted); an admin issues
// (`rendezvous.issue`) as an authority-checked, no-content-state op-log event. Asserts the
// fold, authority enforcement, snapshot round-trip, and order-independent convergence.

import { describe, expect, it } from 'vitest';
import { reduceRoom } from '../reducer/reduce.js';
import { deserializeReducerState, serializeReducerState } from '../reducer/snapshot-state.js';
import { roomStateCommitment } from '../reducer/state.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

const KEY = 'AAAA';
const COMMIT = 'Q29tbWl0bWVudA'; // base64url
let counter = 0;
function mkOp(body: PrivateOpBody, fields: Partial<PrivateRoomOp> = {}): PrivateRoomOp {
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: 'room-1',
    epoch: 0,
    op_id: fields.op_id ?? `op-${++counter}`,
    author_member_id: fields.author_member_id ?? 'founder',
    author_device_id: fields.author_device_id ?? 'founder-dev',
    author_seq: fields.author_seq ?? 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: fields.created_at_bucket ?? '2026-06-22T00',
    lamport: fields.lamport ?? '1',
    parents: fields.parents ?? [],
    body,
  });
}

const member = (id: string, role: 'member' | 'admin', seq: number, lamport: string) =>
  mkOp(
    {
      type: 'member.add',
      member_id: id,
      device_id: `${id}-dev`,
      signing_public_key: KEY,
      hpke_public_key: KEY,
      mls_key_package: KEY,
      granted_role: role,
    },
    { op_id: `add-${id}`, lamport, author_seq: seq, parents: ['genesis'] },
  );

const genesis = mkOp(
  {
    type: 'member.add',
    member_id: 'founder',
    device_id: 'founder-dev',
    signing_public_key: KEY,
    hpke_public_key: KEY,
    mls_key_package: KEY,
    granted_role: 'admin',
  },
  { op_id: 'genesis', lamport: '1' },
);

describe('Tier-2 rendezvous-cap reducer ops', () => {
  it('rendezvous.request sets the author device commitment (converged)', () => {
    const request = mkOp(
      { type: 'rendezvous.request', commitment_with_proof: COMMIT },
      {
        op_id: 'req-bob',
        author_member_id: 'bob',
        author_device_id: 'bob-dev',
        lamport: '3',
        author_seq: 1,
        parents: ['add-bob'],
      },
    );
    const state = reduceRoom([genesis, member('bob', 'member', 1, '2'), request]);
    expect(state.devices.get('bob-dev')?.rendezvousCommitment).toBe(COMMIT);
    // the founder's device, which never requested, has none
    expect(state.devices.get('founder-dev')?.rendezvousCommitment).toBeUndefined();
  });

  it('the commitment survives a snapshot serialize → deserialize round-trip', () => {
    const request = mkOp(
      { type: 'rendezvous.request', commitment_with_proof: COMMIT },
      {
        op_id: 'req-bob',
        author_member_id: 'bob',
        author_device_id: 'bob-dev',
        lamport: '3',
        author_seq: 1,
        parents: ['add-bob'],
      },
    );
    const state = reduceRoom([genesis, member('bob', 'member', 1, '2'), request]);
    const restored = deserializeReducerState(serializeReducerState(state));
    expect(restored.devices.get('bob-dev')?.rendezvousCommitment).toBe(COMMIT);
    // the commitment is part of the converged state commitment
    expect(roomStateCommitment(restored)).toEqual(roomStateCommitment(state));
  });

  it('rendezvous.issue from an ADMIN is accepted and RECORDED in authorized issuances', () => {
    const issue = mkOp(
      {
        type: 'rendezvous.issue',
        target_epoch: 0,
        issuer_public_key: KEY,
        credentials: [{ device_id: 'bob-dev', signature: KEY }],
      },
      { op_id: 'issue', lamport: '3', author_seq: 1, parents: ['genesis'] },
    );
    const state = reduceRoom([genesis, issue]);
    expect(state.rejected.find((r) => r.opId === 'issue')).toBeUndefined(); // accepted
    // The AUTHORIZED issuance is recorded in reduced state — the engine sources installable
    // credentials from HERE, never from raw accepted ops (a non-admin's crypto-valid issue op
    // would otherwise be installable before the reducer rejects it).
    expect(state.rendezvousIssuances).toEqual([
      {
        targetEpoch: 0,
        issuerPublicKey: KEY,
        credentials: [{ device_id: 'bob-dev', signature: KEY }],
      },
    ]);
    // It now participates in the converged commitment (authority-checked Tier-2 state).
    expect(roomStateCommitment(state)).not.toEqual(roomStateCommitment(reduceRoom([genesis])));
  });

  it('rendezvous.issue from a NON-admin member is REJECTED (authority)', () => {
    const issue = mkOp(
      {
        type: 'rendezvous.issue',
        target_epoch: 0,
        issuer_public_key: KEY,
        credentials: [{ device_id: 'bob-dev', signature: KEY }],
      },
      {
        op_id: 'issue',
        author_member_id: 'bob',
        author_device_id: 'bob-dev',
        lamport: '3',
        author_seq: 1,
        parents: ['add-bob'],
      },
    );
    const state = reduceRoom([genesis, member('bob', 'member', 1, '2'), issue]);
    expect(state.rejected.find((r) => r.opId === 'issue')?.reason).toBe('not_authorized');
    // The crux of the fix: an unauthorized (crypto-valid) issue op is NOT recorded as an
    // installable issuance, so the engine can never enroll devices from it.
    expect(state.rendezvousIssuances).toEqual([]);
  });

  it('the fold is order-independent (convergence)', () => {
    const req = mkOp(
      { type: 'rendezvous.request', commitment_with_proof: COMMIT },
      {
        op_id: 'req-bob',
        author_member_id: 'bob',
        author_device_id: 'bob-dev',
        lamport: '3',
        author_seq: 1,
        parents: ['add-bob'],
      },
    );
    const issue = mkOp(
      {
        type: 'rendezvous.issue',
        target_epoch: 0,
        issuer_public_key: KEY,
        credentials: [{ device_id: 'bob-dev', signature: KEY }],
      },
      { op_id: 'issue', lamport: '4', author_seq: 1, parents: ['req-bob'] },
    );
    const ops = [genesis, member('bob', 'member', 1, '2'), req, issue];
    const forward = roomStateCommitment(reduceRoom(ops));
    const reversed = roomStateCommitment(reduceRoom([...ops].reverse()));
    expect(forward).toEqual(reversed);
  });
});
