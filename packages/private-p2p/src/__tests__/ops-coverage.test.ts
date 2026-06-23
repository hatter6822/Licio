// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — every op-body type in the §13.2 discriminated union validates a
// canonical instance through the op envelope, and the role-grant/revoke
// "name a role or a capability" refinements bite.  This exercises the full op
// surface (membership/authority + content) the reducer (WS-S.5) will consume.
import { describe, expect, it } from 'vitest';
import { privateOpBodySchema, privateRoomOpSchema } from '../schemas/ops.js';

const CID = 'bafkreieaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B64 = 'AAAAAAAA';

/** Wrap an op body in a minimal valid op envelope. */
const envelope = (body: unknown) => ({
  schema: 'licio.private.op.v1',
  room_id: 'room-1',
  epoch: 0,
  op_id: 'op-1',
  author_member_id: 'm-1',
  author_device_id: 'd-1',
  author_seq: 0,
  created_at: '2026-06-22T00:00:00Z',
  created_at_bucket: '2026-06-22T00',
  lamport: '1',
  parents: [],
  body,
});

const VALID_BODIES: Array<{ name: string; body: Record<string, unknown> }> = [
  {
    name: 'member.add',
    body: {
      type: 'member.add',
      member_id: 'm-2',
      device_id: 'd-2',
      signing_public_key: B64,
      hpke_public_key: B64,
      mls_key_package: B64,
      granted_role: 'member',
    },
  },
  { name: 'member.remove', body: { type: 'member.remove', member_id: 'm-2', reason: 'left' } },
  {
    name: 'device.remove',
    body: { type: 'device.remove', member_id: 'm-2', device_id: 'd-2' },
  },
  { name: 'role.grant', body: { type: 'role.grant', member_id: 'm-2', role: 'moderator' } },
  {
    name: 'role.grant (capability)',
    body: { type: 'role.grant', member_id: 'm-2', capability: 'moderate' },
  },
  { name: 'role.revoke', body: { type: 'role.revoke', member_id: 'm-2', role: 'moderator' } },
  {
    name: 'member.invite.create',
    body: {
      type: 'member.invite.create',
      invite_id: 'inv-1',
      granted_role: 'member',
      expires_at: '2026-07-01T00:00:00Z',
      max_uses: 1,
      requires_admin_approval: true,
    },
  },
  {
    name: 'recovery.authorize',
    body: { type: 'recovery.authorize', recovery_request_id: 'rr-1', recovering_member_id: 'm-9' },
  },
  {
    name: 'story.create',
    body: {
      type: 'story.create',
      story_id: 's-1',
      thread_id: 't-1',
      title: 'A title',
      submission_type: 'original_brief',
      topic_ids: ['t'],
      submission_metadata: { submission_type: 'original_brief', body: 'b' },
    },
  },
  { name: 'story.edit', body: { type: 'story.edit', story_id: 's-1', title: 'New title' } },
  { name: 'story.tombstone', body: { type: 'story.tombstone', story_id: 's-1' } },
  {
    name: 'thread.state',
    body: {
      type: 'thread.state',
      thread_id: 't-1',
      conversation_state: 'active',
      safety_state: 'normal',
    },
  },
  {
    name: 'contribution.edit',
    body: { type: 'contribution.edit', contribution_id: 'c-1', body_markdown_lite: 'edit' },
  },
  {
    name: 'contribution.tombstone',
    body: { type: 'contribution.tombstone', contribution_id: 'c-1' },
  },
  {
    name: 'summary.create',
    body: {
      type: 'summary.create',
      summary_id: 'sum-1',
      thread_id: 't-1',
      body_markdown_lite: 'A summary.',
    },
  },
  {
    name: 'attachment.add',
    body: {
      type: 'attachment.add',
      attachment_id: 'att-1',
      manifest_cid: CID,
      wrapped_object_key: 'AAAA',
    },
  },
  {
    name: 'snapshot.commit',
    body: {
      type: 'snapshot.commit',
      snapshot_id: 'snap-1',
      includes_ops_up_to: ['op-1'],
      state_merkle_root: B64,
      snapshot_body_cid: CID,
    },
  },
];

describe('WS-S.2.3 every op-body type validates through the op envelope', () => {
  for (const { name, body } of VALID_BODIES) {
    it(`accepts ${name}`, () => {
      expect(privateOpBodySchema.safeParse(body).success).toBe(true);
      expect(privateRoomOpSchema.safeParse(envelope(body)).success).toBe(true);
    });
  }

  it('rejects an unknown op-body type', () => {
    expect(privateOpBodySchema.safeParse({ type: 'not.a.real.op' }).success).toBe(false);
  });

  it('rejects a role.grant / role.revoke that names neither a role nor a capability', () => {
    expect(privateOpBodySchema.safeParse({ type: 'role.grant', member_id: 'm-2' }).success).toBe(
      false,
    );
    expect(privateOpBodySchema.safeParse({ type: 'role.revoke', member_id: 'm-2' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields on an op body (strict)', () => {
    expect(
      privateOpBodySchema.safeParse({ type: 'story.tombstone', story_id: 's-1', extra: 1 }).success,
    ).toBe(false);
  });
});
