// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.7 — local moderation overlay tests (PRIVATE_SPEC §14.6, §19.2): the
// projection hides tombstoned content (the reducer's §14.4 decision) AND the
// member's locally-hidden authors/contributions, muted threads, and blocked
// media; the projection is sorted + deterministic; the overlay round-trips
// through the portable blob (the ONLY way it leaves the device) and exports
// deterministically regardless of insertion order; and a malformed blob rejects.
import { describe, expect, it } from 'vitest';
import {
  emptyOverlay,
  exportOverlay,
  importOverlay,
  type LocalOverlay,
  projectVisibleView,
} from '../reducer/overlay.js';
import { reduceRoom } from '../reducer/reduce.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

const KEY = 'AAAA';
const CID = `b${'a'.repeat(47)}`;
let n = 0;
function mkOp(
  body: PrivateOpBody,
  fields: {
    op_id?: string;
    author_member_id?: string;
    author_device_id?: string;
    author_seq?: number;
    lamport?: string;
    parents?: string[];
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
    lamport: fields.lamport ?? '1',
    parents: fields.parents ?? [],
    body,
  });
}

function buildState() {
  const ops: PrivateRoomOp[] = [
    mkOp(
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
    ),
    mkOp(
      {
        type: 'member.add',
        member_id: 'bob',
        device_id: 'bob-dev',
        signing_public_key: KEY,
        hpke_public_key: KEY,
        mls_key_package: KEY,
        granted_role: 'member',
      },
      { op_id: 'add-bob', lamport: '2', parents: ['genesis'] },
    ),
    mkOp(
      {
        type: 'story.create',
        story_id: 's1',
        thread_id: 't1',
        title: 'Founder story',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
      { op_id: 'cs1', lamport: '3', parents: ['genesis'] },
    ),
    mkOp(
      {
        type: 'story.create',
        story_id: 's2',
        thread_id: 't2',
        title: 'Bob story',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
      {
        op_id: 'cs2',
        author_member_id: 'bob',
        author_device_id: 'bob-dev',
        lamport: '4',
        parents: ['add-bob'],
      },
    ),
    mkOp(
      {
        type: 'contribution.create',
        contribution_id: 'c1',
        thread_id: 't1',
        contribution_type: 'comment',
        body_markdown_lite: 'founder comment',
        citations: [],
        metadata: {},
        client_draft_id: 'd1',
      },
      { op_id: 'cc1', lamport: '5', parents: ['cs1'] },
    ),
    mkOp(
      {
        type: 'contribution.create',
        contribution_id: 'c2',
        thread_id: 't1',
        contribution_type: 'comment',
        body_markdown_lite: 'bob comment',
        citations: [],
        metadata: {},
        client_draft_id: 'd2',
      },
      {
        op_id: 'cc2',
        author_member_id: 'bob',
        author_device_id: 'bob-dev',
        lamport: '6',
        parents: ['cs1'],
      },
    ),
    mkOp(
      { type: 'attachment.add', attachment_id: 'a1', manifest_cid: CID },
      { op_id: 'aa1', lamport: '7', parents: ['cc1'] },
    ),
    mkOp(
      { type: 'attachment.add', attachment_id: 'a2', manifest_cid: CID },
      { op_id: 'aa2', lamport: '8', parents: ['cc1'] },
    ),
  ];
  const state = reduceRoom(ops);
  expect(state.rejected).toHaveLength(0);
  return state;
}

describe('emptyOverlay', () => {
  it('hides nothing', () => {
    const o = emptyOverlay();
    expect(o.hiddenMembers.size).toBe(0);
    expect(o.hiddenContributions.size).toBe(0);
    expect(o.mutedThreads.size).toBe(0);
    expect(o.blockedMedia.size).toBe(0);
  });
});

describe('projectVisibleView', () => {
  it('shows everything through the empty overlay', () => {
    const view = projectVisibleView(buildState(), emptyOverlay());
    expect(view.visibleStoryIds).toStrictEqual(['s1', 's2']);
    expect(view.visibleContributionIds).toStrictEqual(['c1', 'c2']);
    expect(view.visibleAttachmentIds).toStrictEqual(['a1', 'a2']);
  });

  it('hides a member`s stories AND contributions locally', () => {
    const overlay: LocalOverlay = { ...emptyOverlay(), hiddenMembers: new Set(['bob']) };
    const view = projectVisibleView(buildState(), overlay);
    expect(view.visibleStoryIds).toStrictEqual(['s1']);
    expect(view.visibleContributionIds).toStrictEqual(['c1']);
  });

  it('hides a single contribution', () => {
    const overlay: LocalOverlay = { ...emptyOverlay(), hiddenContributions: new Set(['c1']) };
    expect(projectVisibleView(buildState(), overlay).visibleContributionIds).toStrictEqual(['c2']);
  });

  it('mutes a thread (all its contributions)', () => {
    const overlay: LocalOverlay = { ...emptyOverlay(), mutedThreads: new Set(['t1']) };
    expect(projectVisibleView(buildState(), overlay).visibleContributionIds).toStrictEqual([]);
  });

  it('blocks media', () => {
    const overlay: LocalOverlay = { ...emptyOverlay(), blockedMedia: new Set(['a1']) };
    expect(projectVisibleView(buildState(), overlay).visibleAttachmentIds).toStrictEqual(['a2']);
  });

  it('hides tombstoned content regardless of overlay (the reducer`s §14.4 decision)', () => {
    const state = buildState();
    const story = state.stories.get('s1');
    if (story) story.tombstoned = true;
    expect(projectVisibleView(state, emptyOverlay()).visibleStoryIds).toStrictEqual(['s2']);
  });
});

describe('exportOverlay / importOverlay — the device-local round-trip (§14.6)', () => {
  const overlay: LocalOverlay = {
    hiddenMembers: new Set(['bob', 'alice']),
    hiddenContributions: new Set(['c1']),
    mutedThreads: new Set(['t1', 't2']),
    blockedMedia: new Set(['a1']),
  };

  it('round-trips losslessly', () => {
    const imported = importOverlay(exportOverlay(overlay));
    expect([...imported.hiddenMembers].sort()).toStrictEqual(['alice', 'bob']);
    expect([...imported.hiddenContributions]).toStrictEqual(['c1']);
    expect([...imported.mutedThreads].sort()).toStrictEqual(['t1', 't2']);
    expect([...imported.blockedMedia]).toStrictEqual(['a1']);
  });

  it('exports deterministically regardless of set insertion order', () => {
    const a: LocalOverlay = { ...emptyOverlay(), hiddenMembers: new Set(['bob', 'alice']) };
    const b: LocalOverlay = { ...emptyOverlay(), hiddenMembers: new Set(['alice', 'bob']) };
    expect(exportOverlay(a)).toBe(exportOverlay(b));
  });

  it('rejects a malformed blob', () => {
    expect(() => importOverlay('not-valid-base64url-canonical!!')).toThrow();
  });
});
