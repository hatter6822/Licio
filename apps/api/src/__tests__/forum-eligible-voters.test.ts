// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U governance electorate: countEligibleVoters must count exactly the set that
// `isRoomMember` admits to a ballot — active subscribers ∪ stewards, deduped — so
// the frozen ratification/election quorum denominator matches who can actually
// vote (a steward-role holder can vote without an active subscription).
import { DEFAULT_ROOM_NOTIFICATION_PREFERENCES } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { InMemoryRoomStore } from '../forum/stores.js';

describe('RoomStore.countEligibleVoters (in-memory)', () => {
  it('counts active subscribers ∪ stewards, deduped, excluding pending', async () => {
    const store = new InMemoryRoomStore();
    const roomId = 'room-1';
    const sub = (userId: string, status: 'active' | 'pending') =>
      store.upsertSubscription({
        roomId,
        userId,
        status,
        requestId: `req-${userId}`,
        notificationPreferences: DEFAULT_ROOM_NOTIFICATION_PREFERENCES,
        requestedAt: 't',
        joinedAt: status === 'active' ? 't' : null,
      });
    const steward = (userId: string) =>
      store.addSteward({ roomId, userId, role: 'community_steward', assignedAt: 't' });

    await sub('active-only', 'active'); // active subscriber, not a steward
    await steward('steward-only'); // steward with NO subscription (private-room creator case)
    await sub('both', 'active'); // active AND a steward — must count once
    await steward('both');
    await sub('pending-only', 'pending'); // pending request — NOT eligible to vote

    expect(await store.countMembers(roomId)).toBe(2); // active-only + both
    // active-only, both, steward-only (pending excluded; 'both' deduped).
    expect(await store.countEligibleVoters(roomId)).toBe(3);
  });
});
