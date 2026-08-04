// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.4.2d — the ONE bridge-eligibility check the Civic Map and the bridge
// endpoint share.
//
// What is pinned here is the set of bars that used to live in the endpoint and
// be re-derived by the map, because every divergence between the two shipped as
// a published control that could only fail: the room the CONVERSATION is in
// (not the one the story was submitted to), a conversation that still accepts
// contributions, no request already open, and a SCOI baseline.
//
// Plus the property that separates the two callers: a READ may not write. The
// map asks about every node in the landscape, so a recompute there turned one
// GET into a burst of durable degraded rows retained for a year.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bridgeEligibility } from '../invariants/bridge-eligibility.js';
import {
  freshInvariantServices,
  type InvariantServicesFixture,
  seedStory,
  seedUserWithSession,
} from './invariant-test-helpers.js';

/** A server room the acting user stewards, plus a thread pointed at it. */
async function seedBridgeable(
  fixture: InvariantServicesFixture,
  stewardUserId: string,
): Promise<{ roomId: string; threadId: string; storyId: string }> {
  const roomId = randomUUID();
  const inserted = await fixture.forum.rooms.insert({
    roomId,
    name: `Room ${roomId.slice(0, 8)}`,
    slug: `room-${roomId.slice(0, 8)}`,
    description: null,
    roomType: 'global_topic',
    visibility: 'public',
    joinModel: 'open',
    postingPolicy: 'all_members',
    createdBy: null,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: {},
    latestActivityAt: null,
  });
  expect(inserted.ok).toBe(true);
  await fixture.forum.rooms.addSteward({
    roomId,
    userId: stewardUserId,
    role: 'community_steward',
    assignedAt: new Date().toISOString(),
  });
  const { storyId, threadId } = await seedStory(fixture);
  await fixture.ingestion.stories.updateThread(threadId, { roomId });
  return { roomId, threadId, storyId };
}

function deps(fixture: InvariantServicesFixture) {
  return {
    forum: fixture.forum,
    ingestion: fixture.ingestion,
    events: fixture.events,
    invariants: fixture.invariants,
  };
}

describe('bridgeEligibility (WS-H.4.2d)', () => {
  it('asks about the room the CONVERSATION is in, not the one the story names', async () => {
    // A thread moves between rooms (WS-Q) while the story row keeps the room it
    // was submitted to. The steward of the room that actually runs it must be
    // the one who can act.
    const fixture = freshInvariantServices();
    const steward = await seedUserWithSession(fixture.identity);
    const { threadId } = await seedBridgeable(fixture, steward.userId);
    const stranger = await seedUserWithSession(fixture.identity);

    expect(
      (
        await bridgeEligibility(
          deps(fixture),
          threadId,
          {
            userId: stranger.userId,
            roles: ['user'],
          },
          { recompute: true },
        )
      ).ok,
    ).toBe(false);
    // …and the steward of the thread's room is not refused for lack of
    // authority (the SCOI baseline decides the rest).
    const forSteward = await bridgeEligibility(
      deps(fixture),
      threadId,
      { userId: steward.userId, roles: ['user'] },
      { recompute: true },
    );
    if (!forSteward.ok) expect(forSteward.reason).not.toBe('not_found');
  });

  it('refuses a conversation that can no longer receive the bridging contribution', async () => {
    // An archived thread accepts no contributions (`thread_archived`), so a
    // bridge request on it is an attempt nobody can ever answer or be credited
    // for — the map offered it and the endpoint took it.
    const fixture = freshInvariantServices();
    const steward = await seedUserWithSession(fixture.identity);
    const { threadId } = await seedBridgeable(fixture, steward.userId);
    const actor = { userId: steward.userId, roles: ['user'] };

    await fixture.ingestion.stories.updateThread(threadId, { conversationState: 'archived' });
    const archived = await bridgeEligibility(deps(fixture), threadId, actor, { recompute: true });
    expect(archived).toEqual({ ok: false, reason: 'thread_closed' });

    // The WS-J safety lock is the same answer for the same reason.
    await fixture.ingestion.stories.updateThread(threadId, {
      conversationState: 'active',
      safetyState: 'restricted',
    });
    const restricted = await bridgeEligibility(deps(fixture), threadId, actor, { recompute: true });
    expect(restricted).toEqual({ ok: false, reason: 'thread_closed' });
  });

  it('refuses a thread that already has an OPEN request', async () => {
    const fixture = freshInvariantServices();
    const steward = await seedUserWithSession(fixture.identity);
    const { threadId, storyId } = await seedBridgeable(fixture, steward.userId);
    await fixture.invariants.bridgeAttempts.insert({
      attemptId: randomUUID(),
      threadId,
      storyId,
      status: 'requested',
      requestedBy: `steward:${steward.userId}`,
      candidateUserIds: [],
      contributionId: null,
      bridgeUserId: null,
      scoiBaseline: 0.3,
      scoiAfter: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    const verdict = await bridgeEligibility(
      deps(fixture),
      threadId,
      { userId: steward.userId, roles: ['user'] },
      { recompute: true },
    );
    expect(verdict).toEqual({ ok: false, reason: 'already_open' });
  });

  it('WRITES NOTHING in map mode — a read must not persist a year-retained row', async () => {
    // `recomputeScoiFor` persists the computation AND its run metadata before
    // discovering that an insufficient-lens result carries no SCOI value. The
    // map asks about every node, so one GET produced a burst of degraded rows,
    // repeated on every refresh, into a store retained 365 days.
    const fixture = freshInvariantServices();
    const steward = await seedUserWithSession(fixture.identity);
    const { threadId } = await seedBridgeable(fixture, steward.userId);
    const actor = { userId: steward.userId, roles: ['user'] };
    const durable = async (): Promise<number> =>
      (await fixture.events.invariantStore.listAll()).length +
      (await fixture.invariants.runMetadata.listRecent('SCOI', 100)).length;
    const before = await durable();

    const readMode = await bridgeEligibility(deps(fixture), threadId, actor, { recompute: false });
    expect(readMode).toEqual({ ok: false, reason: 'no_scoi' });
    // NOTHING was written — not the (degraded) output, and not the run metadata
    // every guarded run appends, which is the row that grew on every refresh.
    expect(await durable()).toBe(before);

    // The ENDPOINT, about to act on one thread, may still spend the compute —
    // which is the whole reason the flag exists rather than a blanket ban.
    await bridgeEligibility(deps(fixture), threadId, actor, { recompute: true });
    expect(await durable()).toBeGreaterThan(before);
  });

  it('answers not_found for an unknown thread, and for one whose room is gone', async () => {
    const fixture = freshInvariantServices();
    const steward = await seedUserWithSession(fixture.identity);
    const actor = { userId: steward.userId, roles: ['admin'] };
    expect(
      await bridgeEligibility(deps(fixture), randomUUID(), actor, { recompute: true }),
    ).toEqual({ ok: false, reason: 'not_found' });

    // Migration drift: the thread points at a room row that no longer exists.
    // Admin included — there is no steward surface to act through.
    const { threadId } = await seedStory(fixture);
    await fixture.ingestion.stories.updateThread(threadId, { roomId: randomUUID() });
    expect(await bridgeEligibility(deps(fixture), threadId, actor, { recompute: true })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
