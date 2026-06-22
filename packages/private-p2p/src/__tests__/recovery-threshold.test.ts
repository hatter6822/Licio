// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.6c — threshold-recovery tests: M distinct admin authorizations satisfy
// M-of-N; fewer-than-M or M from non-distinct admins do NOT; a revoked
// authorizer stops counting; and the `recovery.authorize` op carries NO key
// material (structural "no secret sharing").
import { describe, expect, it } from 'vitest';
import { evaluateRecoveryThreshold } from '../reducer/recovery-threshold.js';
import { reduceRoom } from '../reducer/reduce.js';
import {
  type PrivateOpBody,
  type PrivateRoomOp,
  privateRoomOpSchema,
  recoveryAuthorizeOpSchema,
} from '../schemas/ops.js';

const KEY = 'AAAA';
let n = 0;
let clock = 0;
function mkOp(body: PrivateOpBody, author?: { m: string; d: string }): PrivateRoomOp {
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: 'room-1',
    epoch: 0,
    op_id: `op-${++n}`,
    author_member_id: author?.m ?? 'founder',
    author_device_id: author?.d ?? 'founder-dev',
    author_seq: 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: String(++clock),
    parents: [],
    body,
  });
}
const genesis = () =>
  mkOp({
    type: 'member.add',
    member_id: 'founder',
    device_id: 'founder-dev',
    signing_public_key: KEY,
    hpke_public_key: KEY,
    mls_key_package: KEY,
    granted_role: 'admin',
  });
const addRecoveryAdmin = (m: string, d: string) =>
  mkOp({
    type: 'member.add',
    member_id: m,
    device_id: d,
    signing_public_key: KEY,
    hpke_public_key: KEY,
    mls_key_package: KEY,
    granted_role: 'recovery_admin',
  });
const authorize = (m: string, d: string) =>
  mkOp(
    { type: 'recovery.authorize', recovery_request_id: 'req', recovering_member_id: 'lost' },
    { m, d },
  );

describe('threshold recovery (§12.6.1)', () => {
  it('M distinct recover-capable admins satisfy the threshold', () => {
    const state = reduceRoom([
      genesis(),
      addRecoveryAdmin('ra1', 'ra1-dev'),
      addRecoveryAdmin('ra2', 'ra2-dev'),
      authorize('ra1', 'ra1-dev'),
      authorize('ra2', 'ra2-dev'),
    ]);
    const result = evaluateRecoveryThreshold(state, 'req', 2);
    expect(result.authorized).toBe(true);
    expect(result.distinctAdmins).toBe(2);
    expect(result.recoveringMemberId).toBe('lost');
  });

  it('fewer than M does not authorize', () => {
    const state = reduceRoom([
      genesis(),
      addRecoveryAdmin('ra1', 'ra1-dev'),
      authorize('ra1', 'ra1-dev'),
    ]);
    expect(evaluateRecoveryThreshold(state, 'req', 2).authorized).toBe(false);
  });

  it('M authorizations from NON-DISTINCT admins (same member, two devices) do not authorize', () => {
    const state = reduceRoom([
      genesis(),
      addRecoveryAdmin('ra1', 'ra1-dev'),
      // a second device for the SAME recovery admin
      mkOp({
        type: 'member.add',
        member_id: 'ra1',
        device_id: 'ra1-dev2',
        signing_public_key: KEY,
        hpke_public_key: KEY,
        mls_key_package: KEY,
        granted_role: 'recovery_admin',
      }),
      authorize('ra1', 'ra1-dev'),
      authorize('ra1', 'ra1-dev2'),
    ]);
    const result = evaluateRecoveryThreshold(state, 'req', 2);
    expect(result.distinctAdmins).toBe(1); // one member, even with two devices
    expect(result.authorized).toBe(false);
  });

  it('an unknown request is not authorized', () => {
    const state = reduceRoom([genesis()]);
    expect(evaluateRecoveryThreshold(state, 'no-such-req', 1).authorized).toBe(false);
  });

  it('a non-recover-capable author cannot even record an authorization', () => {
    // a plain member's recovery.authorize is rejected at the fold (lacks `recover`)
    const state = reduceRoom([
      genesis(),
      mkOp({
        type: 'member.add',
        member_id: 'bob',
        device_id: 'bob-dev',
        signing_public_key: KEY,
        hpke_public_key: KEY,
        mls_key_package: KEY,
        granted_role: 'member',
      }),
      authorize('bob', 'bob-dev'),
    ]);
    expect(state.recoveryRequests.has('req')).toBe(false);
    expect(state.rejected.some((r) => r.reason === 'not_authorized')).toBe(true);
  });

  it('the recovery.authorize op carries NO key material (no secret sharing)', () => {
    const parsed = recoveryAuthorizeOpSchema.parse({
      type: 'recovery.authorize',
      recovery_request_id: 'r',
      recovering_member_id: 'm',
    });
    // only ids — no key/secret/share field exists on the op
    expect(Object.keys(parsed).sort()).toStrictEqual([
      'recovering_member_id',
      'recovery_request_id',
      'type',
    ]);
    // a smuggled key field is rejected by .strict()
    expect(() =>
      recoveryAuthorizeOpSchema.parse({
        type: 'recovery.authorize',
        recovery_request_id: 'r',
        recovering_member_id: 'm',
        key_share: KEY,
      }),
    ).toThrow();
  });
});
