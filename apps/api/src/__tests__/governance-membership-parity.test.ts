// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE DRIFT GUARD for governance membership.
//
// Two spellings decide who governs a room, and they have to be the same set:
//
//   - the BALLOT GATE — `isGovernanceMember` (apps/api/src/forum/rooms.ts), reached
//     through the knomosis `isMember` port, which gates voting, proposing, delegating
//     and knomosis submits;
//   - the DENOMINATOR — `listEligibleVoterIds` / `countEligibleVoters`, the roster the
//     frozen quorum basis is measured over.
//
// When they disagree the failure is silent and lands on a governance outcome. Too WIDE
// a gate lets somebody vote who was never counted, so turnout can exceed 100% of the
// electorate the result is measured against. Too NARROW a denominator makes quorum
// easier than the law pack asks for; too wide makes it unreachable however many
// eligible members vote.
//
// They had diverged exactly that way: the gate read `isRoomSteward`, whose first line
// returns true for any platform `admin` — and for any platform `steward` in a room it
// can see, which is every public room — while the roster counts only active
// subscriptions and PER-ROOM steward grants. A platform admin could therefore cast a
// ballot in every server room while appearing in no denominator.
//
// This file is the structural guarantee that they cannot drift again: it enumerates
// every KIND of account the two could disagree about and asserts one answer from both.
// A new arm on either side fails here unless the same arm is added to the other.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isGovernanceMember } from '../forum/rooms.js';
import { buildRoomGovernancePort } from '../knomosis/wiring.js';
import { seedUserWithSession } from './event-test-helpers.js';
import { freshForumServices } from './forum-test-helpers.js';
import { freshKnomosisServices } from './knomosis-test-helpers.js';

describe('governance membership: the ballot gate and the denominator are one set', () => {
  it('agrees on EVERY kind of account the two could disagree about', async () => {
    const forumFixture = freshForumServices();
    const knomosisFixture = await freshKnomosisServices();
    const forum = forumFixture.forum;
    const roomId = randomUUID();
    await forum.rooms.insert({
      roomId,
      name: 'Parity',
      slug: `parity-${roomId.slice(0, 8)}`,
      description: null,
      roomType: 'global_topic',
      // PUBLIC on purpose: the platform-steward arm of `isRoomSteward` keys on
      // `roomContentVisibleToUser`, which is true for every public room — so a public
      // room is where the old gate was widest.
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      createdBy: null,
      governanceMode: 'simulated',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });

    const mk = async (over: { admin?: boolean; steward?: boolean } = {}) =>
      (await seedUserWithSession(knomosisFixture.identity, over)).userId;

    const activeSubscriber = await mk();
    const pendingSubscriber = await mk();
    const roomStewardGrant = await mk();
    const platformAdmin = await mk({ admin: true });
    const platformSteward = await mk({ steward: true });
    const outsider = await mk();
    // An account holding BOTH a platform role and real stake — the platform role must
    // neither add nor remove membership, so this one is a member on its own merits.
    const adminWhoAlsoSubscribed = await mk({ admin: true });

    const now = new Date().toISOString();
    for (const [userId, status] of [
      [activeSubscriber, 'active'],
      [pendingSubscriber, 'pending'],
      [adminWhoAlsoSubscribed, 'active'],
    ] as const) {
      await forum.rooms.upsertSubscription({
        roomId,
        userId,
        status,
        requestId: randomUUID(),
        lensId: null,
        requestedAt: now,
        joinedAt: status === 'active' ? now : null,
      });
    }
    await forum.rooms.addSteward({
      roomId,
      userId: roomStewardGrant,
      role: 'community_steward',
      assignedAt: now,
    });

    /** What the platform intends, stated once, in one place. */
    const expected: ReadonlyArray<readonly [string, boolean, string]> = [
      [activeSubscriber, true, 'an active subscriber'],
      [pendingSubscriber, false, 'a PENDING subscriber has not joined yet'],
      [roomStewardGrant, true, 'a PER-ROOM steward grant (WS-L.3.1a: no subscription needed)'],
      [platformAdmin, false, 'a platform ADMIN does not vote in any room'],
      [platformSteward, false, 'a platform STEWARD has oversight, not a stake'],
      [outsider, false, 'a stranger'],
      [adminWhoAlsoSubscribed, true, 'an admin who genuinely subscribed, on its own merits'],
    ];

    const rooms = buildRoomGovernancePort(forum, knomosisFixture.identity);
    const roster = new Set(await forum.rooms.listEligibleVoterIds(roomId));

    for (const [userId, want, why] of expected) {
      // 1. the predicate itself
      expect(await isGovernanceMember(forum, roomId, userId), `predicate: ${why}`).toBe(want);
      // 2. the port the ballot gate actually calls
      expect(await rooms.isMember(roomId, userId), `ballot gate: ${why}`).toBe(want);
      // 3. the roster the denominator is measured over
      expect(roster.has(userId), `denominator: ${why}`).toBe(want);
    }

    // …and the COUNT agrees with the roster it is supposed to summarise, so a member
    // cannot be inside one and outside the other.
    expect(await forum.rooms.countEligibleVoters(roomId)).toBe(roster.size);
    expect(roster.size).toBe(expected.filter(([, want]) => want).length);

    // ADMINISTRATION is a different question and is untouched: `isSteward` still says
    // yes for the platform roles, which is what its 13 call sites depend on.
    expect(await rooms.isSteward(roomId, platformAdmin)).toBe(true);
    expect(await rooms.isSteward(roomId, platformSteward)).toBe(true);
  });
});
