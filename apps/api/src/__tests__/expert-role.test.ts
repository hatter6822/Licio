// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The platform `expert` role (WS-D RBAC): a LEAST-PRIVILEGE content role. Its
// only distinct capability is posting top-level in expert-gated rooms; it holds
// NO moderation/governance/admin power, and it never bypasses a room's content
// (read) bar. Proven at both the RBAC-policy layer and the forum-authorization
// chokepoint (`userMayPostTopLevel`).
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { userMayPostTopLevel } from '../forum/rooms.js';
import { authorize, isSteward, ROLES } from '../identity/rbac.js';
import { type ForumServicesFixture, freshForumServices } from './forum-test-helpers.js';

let fx: ForumServicesFixture;
beforeEach(() => {
  fx = freshForumServices();
});

async function room(
  visibility: 'public' | 'private',
  postingPolicy: 'all_members' | 'experts_and_stewards',
): Promise<string> {
  const roomId = randomUUID();
  await fx.forum.rooms.insert({
    roomId,
    name: `Room ${roomId.slice(0, 8)}`,
    slug: `room-${roomId.slice(0, 8)}`,
    description: null,
    roomType: 'global_topic',
    visibility,
    joinModel: visibility === 'public' ? 'open' : 'request_approval',
    postingPolicy,
    createdBy: null,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: {},
    latestActivityAt: null,
  });
  return roomId;
}

async function joinMember(roomId: string, userId: string): Promise<void> {
  await fx.forum.rooms.upsertSubscription({
    roomId,
    userId,
    status: 'active',
    requestId: randomUUID(),
    lensId: null,
    notificationPreferences: {
      threads: 'mentions',
      bridge_requests: false,
      steward_announcements: true,
    },
    requestedAt: new Date().toISOString(),
    joinedAt: new Date().toISOString(),
  });
}

describe('expert role — RBAC least privilege (WS-D.1.6b)', () => {
  it('is a known role with no platform powers beyond self-management', () => {
    expect(ROLES).toContain('expert');
    expect(authorize(['expert'], 'self.manage')).toBe(true);
    // It can NEVER moderate, read the audit log, or assign roles.
    expect(authorize(['expert'], 'moderation.act')).toBe(false);
    expect(authorize(['expert'], 'steward.audit.read')).toBe(false);
    expect(authorize(['expert'], 'admin.role.assign')).toBe(false);
    // An expert is not a steward (steward-gated surfaces stay closed to it).
    expect(isSteward(['expert'])).toBe(false);
  });

  it('grants no MORE than a plain user at the platform layer', () => {
    const actions = [
      'self.manage',
      'moderation.act',
      'steward.audit.read',
      'admin.role.assign',
    ] as const;
    for (const action of actions) {
      expect(authorize(['expert'], action)).toBe(authorize(['user'], action));
    }
  });
});

describe('expert role — expert-gated room posting (WS-Q.3.1b)', () => {
  it('may post top-level in a public experts_and_stewards room; a plain user may not', async () => {
    const r = await room('public', 'experts_and_stewards');
    const expertRoom = await fx.forum.rooms.getById(r);
    if (!expertRoom) throw new Error('room missing');
    expect(await userMayPostTopLevel(fx.forum, expertRoom, 'expert-1', ['user', 'expert'])).toBe(
      true,
    );
    expect(await userMayPostTopLevel(fx.forum, expertRoom, 'plain-1', ['user'])).toBe(false);
    // A steward still qualifies (unchanged), and an admin (platform steward) too.
    expect(await userMayPostTopLevel(fx.forum, expertRoom, 'stew-1', ['user', 'steward'])).toBe(
      true,
    );
  });

  it('posting in an all_members room is unaffected (everyone may)', async () => {
    const r = await room('public', 'all_members');
    const open = await fx.forum.rooms.getById(r);
    if (!open) throw new Error('room missing');
    expect(await userMayPostTopLevel(fx.forum, open, 'plain-2', ['user'])).toBe(true);
    expect(await userMayPostTopLevel(fx.forum, open, 'expert-2', ['user', 'expert'])).toBe(true);
  });

  it('does NOT bypass a private room content bar — read access is still required', async () => {
    const r = await room('private', 'experts_and_stewards');
    const priv = await fx.forum.rooms.getById(r);
    if (!priv) throw new Error('room missing');
    // An expert who is NOT a member of the private room cannot read it, so cannot post.
    expect(await userMayPostTopLevel(fx.forum, priv, 'expert-3', ['user', 'expert'])).toBe(false);
    // Once an active member, the expert role lets them post there.
    await joinMember(r, 'expert-3');
    expect(await userMayPostTopLevel(fx.forum, priv, 'expert-3', ['user', 'expert'])).toBe(true);
  });
});
