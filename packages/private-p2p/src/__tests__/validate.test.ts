// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.3 — structural validation pre-pass tests: room match, missing-parent
// quarantine, the §14.3.1 Lamport-after-parents rule, per-device monotonic
// sequence (a device fork at the same seq is caught), and duplicate op ids.
import { describe, expect, it } from 'vitest';
import { validateStructure } from '../reducer/validate.js';
import type { PrivateOpBody, PrivateRoomOp } from '../schemas/ops.js';
import { privateRoomOpSchema } from '../schemas/ops.js';

let n = 0;
function op(fields: {
  op_id?: string;
  room_id?: string;
  author_device_id?: string;
  author_seq?: number;
  lamport?: string;
  parents?: string[];
}): PrivateRoomOp {
  const body: PrivateOpBody = { type: 'member.remove', member_id: 'x' };
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: fields.room_id ?? 'room-1',
    epoch: 0,
    op_id: fields.op_id ?? `op-${++n}`,
    author_member_id: 'm',
    author_device_id: fields.author_device_id ?? 'd',
    author_seq: fields.author_seq ?? 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: fields.lamport ?? '1',
    parents: fields.parents ?? [],
    body,
  });
}

describe('validateStructure (§14.2)', () => {
  it('accepts a clean causal chain', () => {
    const a = op({ op_id: 'a', author_seq: 0, lamport: '1' });
    const b = op({ op_id: 'b', author_seq: 1, lamport: '2', parents: ['a'] });
    const { accepted, quarantined } = validateStructure([b, a], 'room-1');
    expect(accepted.map((o) => o.op_id)).toStrictEqual(['a', 'b']); // canonical order
    expect(quarantined).toHaveLength(0);
  });

  it('quarantines a room mismatch', () => {
    const r = validateStructure([op({ op_id: 'x', room_id: 'other' })], 'room-1');
    expect(r.accepted).toHaveLength(0);
    expect(r.quarantined[0]).toMatchObject({ opId: 'x', reason: 'room_mismatch' });
  });

  it('quarantines an op whose parent is absent (missing dependency)', () => {
    const orphan = op({ op_id: 'o', lamport: '5', parents: ['nope'] });
    const r = validateStructure([orphan], 'room-1');
    expect(r.quarantined[0]).toMatchObject({ opId: 'o', reason: 'missing_dependency' });
  });

  it('rejects a lamport not strictly greater than a parent', () => {
    const a = op({ op_id: 'a', lamport: '1' });
    const bad = op({ op_id: 'b', lamport: '1', parents: ['a'] }); // equal, not greater
    const r = validateStructure([a, bad], 'room-1');
    expect(r.accepted.map((o) => o.op_id)).toStrictEqual(['a']);
    expect(r.quarantined[0]).toMatchObject({ opId: 'b', reason: 'lamport_not_after_parents' });
  });

  it('quarantines an op whose lamport jumps beyond runningMax + 1 (anti-DoS)', () => {
    const a = op({ op_id: 'a', lamport: '1' });
    // A near-cap lamport with no causal justification: unbounded, this poisons
    // nextLamport and freezes authoring (§14.3.1).
    const poison = op({ op_id: 'p', author_seq: 1, lamport: '9'.repeat(40) });
    const r = validateStructure([a, poison], 'room-1');
    expect(r.accepted.map((o) => o.op_id)).toStrictEqual(['a']);
    expect(r.quarantined.some((q) => q.opId === 'p' && q.reason === 'lamport_jump_exceeded')).toBe(
      true,
    );
  });

  it('rejects a non-monotonic per-device author_seq (device fork)', () => {
    const a = op({ op_id: 'a', author_device_id: 'd', author_seq: 3, lamport: '1' });
    const fork = op({ op_id: 'b', author_device_id: 'd', author_seq: 3, lamport: '2' }); // same seq
    const r = validateStructure([a, fork], 'room-1');
    expect(r.accepted.map((o) => o.op_id)).toStrictEqual(['a']);
    expect(r.quarantined[0]).toMatchObject({ opId: 'b', reason: 'non_monotonic_author_seq' });
  });

  it('allows independent devices to have independent sequences', () => {
    const a = op({ op_id: 'a', author_device_id: 'd1', author_seq: 0, lamport: '1' });
    const b = op({ op_id: 'b', author_device_id: 'd2', author_seq: 0, lamport: '1' });
    expect(validateStructure([a, b], 'room-1').accepted).toHaveLength(2);
  });

  it('quarantines a duplicate op_id', () => {
    const a = op({ op_id: 'dup', lamport: '1' });
    const b = op({ op_id: 'dup', lamport: '2' });
    const r = validateStructure([a, b], 'room-1');
    expect(r.accepted).toHaveLength(1);
    expect(r.quarantined[0]).toMatchObject({ reason: 'duplicate_op_id' });
  });
});
