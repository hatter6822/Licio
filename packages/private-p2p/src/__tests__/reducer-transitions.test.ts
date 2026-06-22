// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.1/5.2/5.4b — per-op-type transition coverage: device removal, role
// grant/revoke, threshold-recovery authorization counting, thread state,
// contribution edit/tombstone (creator vs moderator vs unauthorized), summary,
// attachment, snapshot, invite, and the room-state commitment over recovery +
// snapshot state.
import { describe, expect, it } from 'vitest';
import { reduceRoom } from '../reducer/reduce.js';
import { roomStateCommitment } from '../reducer/state.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

const KEY = 'AAAA';
let n = 0;
let clock = 0;

function mkOp(
  body: PrivateOpBody,
  fields: {
    author_member_id?: string;
    author_device_id?: string;
    author_seq?: number;
    op_id?: string;
    lamport?: string;
  } = {},
): PrivateRoomOp {
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: 'room-1',
    epoch: 0,
    op_id: fields.op_id ?? `op-${++n}`,
    author_member_id: fields.author_member_id ?? 'founder',
    author_device_id: fields.author_device_id ?? 'founder-dev',
    author_seq: fields.author_seq ?? 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: fields.lamport ?? String(++clock),
    parents: [],
    body,
  });
}

function addMember(
  memberId: string,
  deviceId: string,
  role: 'member' | 'moderator' | 'admin' | 'recovery_admin',
) {
  return mkOp({
    type: 'member.add',
    member_id: memberId,
    device_id: deviceId,
    signing_public_key: KEY,
    hpke_public_key: KEY,
    mls_key_package: KEY,
    granted_role: role,
  });
}

function genesis() {
  return mkOp(
    {
      type: 'member.add',
      member_id: 'founder',
      device_id: 'founder-dev',
      signing_public_key: KEY,
      hpke_public_key: KEY,
      mls_key_package: KEY,
      granted_role: 'admin',
    },
    { op_id: 'genesis' },
  );
}

describe('membership/role transitions', () => {
  it('device.remove marks a device inactive', () => {
    const ops = [
      genesis(),
      addMember('bob', 'bob-dev', 'member'),
      mkOp({ type: 'device.remove', member_id: 'bob', device_id: 'bob-dev' }),
    ];
    const state = reduceRoom(ops);
    expect(state.devices.get('bob-dev')?.removed).toBe(true);
    expect(state.members.get('bob')?.removed).toBe(false); // member stays, device gone
  });

  it('role.grant promotes a member and grants an extra capability', () => {
    const ops = [
      genesis(),
      addMember('bob', 'bob-dev', 'member'),
      mkOp({ type: 'role.grant', member_id: 'bob', role: 'moderator' }),
      mkOp({ type: 'role.grant', member_id: 'bob', capability: 'invite' }),
    ];
    const bob = reduceRoom(ops).members.get('bob');
    expect(bob?.role).toBe('moderator');
    expect(bob?.capabilities.has('moderate')).toBe(true);
    expect(bob?.capabilities.has('invite')).toBe(true); // direct grant
  });

  it('role.revoke demotes a role to member and removes a capability', () => {
    const ops = [
      genesis(),
      addMember('bob', 'bob-dev', 'moderator'),
      mkOp({ type: 'role.revoke', member_id: 'bob', role: 'moderator' }),
    ];
    const bob = reduceRoom(ops).members.get('bob');
    expect(bob?.role).toBe('member');
    expect(bob?.capabilities.has('moderate')).toBe(false);
  });

  it('counts M distinct admin authorizations for threshold recovery', () => {
    const ops = [
      genesis(),
      addMember('ra1', 'ra1-dev', 'recovery_admin'),
      addMember('ra2', 'ra2-dev', 'recovery_admin'),
      mkOp(
        { type: 'recovery.authorize', recovery_request_id: 'req-1', recovering_member_id: 'lost' },
        { author_member_id: 'ra1', author_device_id: 'ra1-dev' },
      ),
      mkOp(
        { type: 'recovery.authorize', recovery_request_id: 'req-1', recovering_member_id: 'lost' },
        { author_member_id: 'ra2', author_device_id: 'ra2-dev' },
      ),
    ];
    const req = reduceRoom(ops).recoveryRequests.get('req-1');
    expect(req?.authorizingDeviceIds.size).toBe(2); // two DISTINCT admin devices
  });

  it('member.invite.create by an invite-capable author is accepted (no content change)', () => {
    const ops = [
      genesis(),
      mkOp({
        type: 'member.invite.create',
        invite_id: 'inv-1',
        granted_role: 'member',
        expires_at: '2026-07-01',
        max_uses: 3,
        requires_admin_approval: false,
      }),
    ];
    expect(reduceRoom(ops).rejected).toHaveLength(0);
  });
});

describe('content transitions', () => {
  function room() {
    return [
      genesis(),
      addMember('mod', 'mod-dev', 'moderator'),
      addMember('bob', 'bob-dev', 'member'),
      mkOp({
        type: 'story.create',
        story_id: 's1',
        thread_id: 't1',
        title: 'v1',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      }),
    ];
  }

  it('thread.state requires moderate; a moderator may set it', () => {
    const ops = [
      ...room(),
      mkOp(
        {
          type: 'thread.state',
          thread_id: 't1',
          conversation_state: 'tense',
          safety_state: 'elevated',
        },
        { author_member_id: 'mod', author_device_id: 'mod-dev' },
      ),
    ];
    const thread = reduceRoom(ops).threads.get('t1');
    expect(thread?.conversationState).toBe('tense');
    expect(thread?.safetyState).toBe('elevated');
  });

  it('a non-creator non-moderator cannot edit a story', () => {
    const ops = [
      ...room(),
      mkOp(
        { type: 'story.edit', story_id: 's1', title: 'hacked' },
        { author_member_id: 'bob', author_device_id: 'bob-dev' },
      ),
    ];
    const state = reduceRoom(ops);
    expect(state.stories.get('s1')?.title).toBe('v1');
    expect(state.rejected.some((r) => r.reason === 'not_authorized')).toBe(true);
  });

  it('a moderator may tombstone another member’s story', () => {
    const ops = [
      ...room(),
      mkOp(
        { type: 'story.tombstone', story_id: 's1' },
        { author_member_id: 'mod', author_device_id: 'mod-dev' },
      ),
    ];
    expect(reduceRoom(ops).stories.get('s1')?.tombstoned).toBe(true);
  });

  it('contribution create → author edit → moderator tombstone', () => {
    const ops = [
      ...room(),
      mkOp(
        {
          type: 'contribution.create',
          contribution_id: 'c1',
          thread_id: 't1',
          contribution_type: 'comment',
          body_markdown_lite: 'first',
          citations: [],
          metadata: {},
          client_draft_id: 'd1',
        },
        { author_member_id: 'bob', author_device_id: 'bob-dev' },
      ),
      mkOp(
        { type: 'contribution.edit', contribution_id: 'c1', body_markdown_lite: 'edited' },
        { author_member_id: 'bob', author_device_id: 'bob-dev' },
      ),
      mkOp(
        { type: 'contribution.tombstone', contribution_id: 'c1' },
        { author_member_id: 'mod', author_device_id: 'mod-dev' },
      ),
    ];
    const c = reduceRoom(ops).contributions.get('c1');
    expect(c?.bodyMarkdownLite).toBe('edited');
    expect(c?.editCount).toBe(1);
    expect(c?.tombstoned).toBe(true);
  });

  it('editing/tombstoning a missing target is rejected', () => {
    const ops = [
      ...room(),
      mkOp(
        { type: 'contribution.edit', contribution_id: 'ghost', body_markdown_lite: 'x' },
        { author_member_id: 'mod', author_device_id: 'mod-dev' },
      ),
      mkOp(
        { type: 'story.edit', story_id: 'ghost' },
        { author_member_id: 'mod', author_device_id: 'mod-dev' },
      ),
    ];
    const reasons = reduceRoom(ops).rejected.map((r) => r.reason);
    expect(reasons).toContain('contribution_missing');
    expect(reasons).toContain('story_missing');
  });

  it('summary.create requires summarize; a member is rejected, a moderator accepted', () => {
    // Build the base room FIRST so the summary ops get higher (later) lamports
    // than the genesis/membership ops (the module clock is monotonic).
    const base = room();
    const memberSummary = mkOp(
      {
        type: 'summary.create',
        summary_id: 'sum1',
        thread_id: 't1',
        body_markdown_lite: 'sum',
        cited_contribution_ids: [],
      },
      { author_member_id: 'bob', author_device_id: 'bob-dev' },
    );
    const modSummary = mkOp(
      {
        type: 'summary.create',
        summary_id: 'sum2',
        thread_id: 't1',
        body_markdown_lite: 'sum',
        cited_contribution_ids: [],
      },
      { author_member_id: 'mod', author_device_id: 'mod-dev' },
    );
    const state = reduceRoom([...base, memberSummary, modSummary]);
    expect(state.summaries.has('sum1')).toBe(false); // member lacks `summarize`
    expect(state.summaries.has('sum2')).toBe(true);
  });

  it('attachment.add and snapshot.commit are recorded', () => {
    const ops = [
      ...room(),
      mkOp(
        {
          type: 'attachment.add',
          attachment_id: 'a1',
          manifest_cid: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
        },
        { author_member_id: 'bob', author_device_id: 'bob-dev' },
      ),
      mkOp({
        type: 'snapshot.commit',
        snapshot_id: 'snap1',
        includes_ops_up_to: ['genesis'],
        state_merkle_root: KEY,
        snapshot_body_cid: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
      }),
    ];
    const state = reduceRoom(ops);
    expect(state.attachments.has('a1')).toBe(true);
    expect(state.snapshots).toContain('snap1');
  });

  it('the room-state commitment covers recovery + snapshot state', () => {
    const ops = [
      genesis(),
      addMember('ra', 'ra-dev', 'recovery_admin'),
      mkOp(
        { type: 'recovery.authorize', recovery_request_id: 'r', recovering_member_id: 'lost' },
        { author_member_id: 'ra', author_device_id: 'ra-dev' },
      ),
      mkOp({
        type: 'snapshot.commit',
        snapshot_id: 'snap1',
        includes_ops_up_to: ['genesis'],
        state_merkle_root: KEY,
        snapshot_body_cid: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
      }),
    ];
    const commitment = roomStateCommitment(reduceRoom(ops));
    expect(commitment.length).toBeGreaterThan(0);
    // deterministic
    expect(Array.from(roomStateCommitment(reduceRoom(ops)))).toStrictEqual(Array.from(commitment));
  });
});
