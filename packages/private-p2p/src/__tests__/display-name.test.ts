// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — member display-name mapping (PRIVATE_SPEC §12.3 / §14.3.3).  The
// display name folds from the signed `member.add` op into reduced MemberState,
// converges across devices, is part of the state commitment, and NEVER affects
// authority (capabilities stay keyed by role).

import { describe, expect, it } from 'vitest';
import { reduceRoom } from '../reducer/reduce.js';
import { roomStateCommitment } from '../reducer/state.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

const KEY = 'AAAA';
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

const genesis = (displayName?: string): PrivateRoomOp =>
  mkOp(
    {
      type: 'member.add',
      member_id: 'founder',
      device_id: 'founder-dev',
      signing_public_key: KEY,
      hpke_public_key: KEY,
      mls_key_package: KEY,
      granted_role: 'admin',
      ...(displayName !== undefined ? { display_name: displayName } : {}),
    },
    { op_id: 'genesis', lamport: '1' },
  );

const addMember = (memberId: string, role: 'member' | 'moderator', displayName?: string) =>
  mkOp(
    {
      type: 'member.add',
      member_id: memberId,
      device_id: `${memberId}-dev`,
      signing_public_key: KEY,
      hpke_public_key: KEY,
      mls_key_package: KEY,
      granted_role: role,
      ...(displayName !== undefined ? { display_name: displayName } : {}),
    },
    { op_id: `add-${memberId}`, lamport: '2', author_seq: 1, parents: ['genesis'] },
  );

describe('WS-S.7.4 display-name mapping', () => {
  it('folds the signed member.add display_name into MemberState', () => {
    const state = reduceRoom([genesis('Founder Fran'), addMember('bob', 'member', 'Bob B.')]);
    expect(state.members.get('founder')?.displayName).toBe('Founder Fran');
    expect(state.members.get('bob')?.displayName).toBe('Bob B.');
  });

  it('leaves displayName undefined when the op carries no name', () => {
    const state = reduceRoom([genesis(), addMember('bob', 'member')]);
    expect(state.members.get('bob')?.displayName).toBeUndefined();
  });

  it('converges across shuffled delivery orders (name is in the commitment)', () => {
    const ops = [genesis('Founder Fran'), addMember('bob', 'member', 'Bob B.')];
    const a = roomStateCommitment(reduceRoom(ops));
    const b = roomStateCommitment(reduceRoom([...ops].reverse()));
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('is part of the commitment — a different name yields a different commitment', () => {
    const named = roomStateCommitment(
      reduceRoom([genesis(), addMember('bob', 'member', 'Bob B.')]),
    );
    const renamed = roomStateCommitment(
      reduceRoom([genesis(), addMember('bob', 'member', 'Robert')]),
    );
    expect(Array.from(renamed)).not.toEqual(Array.from(named));
  });

  it('NEVER affects authority — capabilities stay keyed by role, not name', () => {
    const plain = reduceRoom([genesis(), addMember('bob', 'member')]);
    const flashy = reduceRoom([
      genesis(),
      addMember('bob', 'member', 'Bob the Magnificent Admin Overlord'),
    ]);
    // Same role ⇒ byte-identical capability set regardless of the display name.
    expect([...(flashy.members.get('bob')?.capabilities ?? [])].sort()).toEqual(
      [...(plain.members.get('bob')?.capabilities ?? [])].sort(),
    );
    // The attacker-chosen name did not smuggle in any capability: bob (member) holds a
    // STRICT SUBSET of the admin founder's capabilities, by role alone.
    const bobCaps = flashy.members.get('bob')?.capabilities ?? new Set<string>();
    const adminCaps = flashy.members.get('founder')?.capabilities ?? new Set<string>();
    expect([...bobCaps].every((c) => adminCaps.has(c))).toBe(true);
    expect(bobCaps.size).toBeLessThan(adminCaps.size); // a member has fewer caps than the admin founder
  });
});
