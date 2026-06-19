// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U real author-history reader (SPEC §24.6) + canonical link/mention token
// counting. The reader sources the three policy-DSL author signals
// (author_account_age_lt_days, author_new_to_room, prior_removals_in_room_gte)
// from the identity articulation node + the forum stores, so a room's policy
// conditions on them actually fire (the prior hardcoded defaults neutered them).
import { describe, expect, it } from 'vitest';
import {
  AUTHOR_HISTORY_SCAN_CAP,
  type AuthorHistoryReaderDeps,
  buildAuthorHistoryReader,
  countLinkTokens,
  countMentionTokens,
} from '../governance/forum-agent.js';

const NOW = Date.parse('2026-06-19T00:00:00.000Z');

function deps(over: Partial<AuthorHistoryReaderDeps> = {}): AuthorHistoryReaderDeps {
  return {
    getUser: async () => ({ createdAt: '2026-06-09T00:00:00.000Z' }), // 10 days old
    getSubscription: async () => null,
    stewardRolesFor: async () => [],
    listUserContributions: async () => [],
    getThreadRoomId: async () => null,
    now: () => NOW,
    ...over,
  };
}

describe('buildAuthorHistoryReader', () => {
  it('computes account age in whole days from the identity node', async () => {
    const read = buildAuthorHistoryReader(deps());
    expect((await read('room-1', 'author-1')).accountAgeDays).toBe(10);
  });

  it('treats an unknown account as brand-new (age 0, never lenient)', async () => {
    const read = buildAuthorHistoryReader(deps({ getUser: async () => null }));
    expect((await read('room-1', 'author-1')).accountAgeDays).toBe(0);
  });

  it('is not new-to-room for an established member (active + joined)', async () => {
    const read = buildAuthorHistoryReader(
      deps({
        getSubscription: async () => ({ status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' }),
      }),
    );
    expect((await read('room-1', 'author-1')).newToRoom).toBe(false);
  });

  it('is not new-to-room for a room steward (no subscription)', async () => {
    const read = buildAuthorHistoryReader(
      deps({ stewardRolesFor: async () => ['community_steward'] }),
    );
    expect((await read('room-1', 'author-1')).newToRoom).toBe(false);
  });

  it('is new-to-room for a non-member (pending sub, no steward role)', async () => {
    const read = buildAuthorHistoryReader(
      deps({ getSubscription: async () => ({ status: 'pending', joinedAt: null }) }),
    );
    expect((await read('room-1', 'author-1')).newToRoom).toBe(true);
  });

  it('counts only REMOVED contributions whose thread is in THIS room', async () => {
    const read = buildAuthorHistoryReader(
      deps({
        listUserContributions: async () => [
          { threadId: 't-here-1', moderationState: 'removed' }, // counts
          { threadId: 't-here-2', moderationState: 'published' }, // wrong state
          { threadId: 't-other', moderationState: 'removed' }, // wrong room
          { threadId: 't-here-3', moderationState: 'removed' }, // counts
        ],
        getThreadRoomId: async (threadId) => (threadId.startsWith('t-here') ? 'room-1' : 'room-2'),
      }),
    );
    expect((await read('room-1', 'author-1')).priorRemovalsInRoom).toBe(2);
  });

  it('exposes a positive bounded scan cap', () => {
    expect(AUTHOR_HISTORY_SCAN_CAP).toBeGreaterThan(0);
  });
});

describe('canonical link/mention token counting', () => {
  it('counts one per http(s) token across mixed whitespace, ignoring non-URLs', () => {
    // Spaces, tabs, and newlines all delimit; ftp/non-scheme tokens are ignored.
    expect(countLinkTokens('see https://a.test\tand\nhttp://b.test or ftp://c.test x')).toBe(2);
    expect(countLinkTokens('no links here at all')).toBe(0);
    expect(countLinkTokens('')).toBe(0);
  });

  it('counts @handle mentions but not email addresses or bare @', () => {
    expect(countMentionTokens('hi @alice and @bob_99')).toBe(2);
    expect(countMentionTokens('mail me at someone@example.com')).toBe(0);
    expect(countMentionTokens('a lone @ sign and @!punct')).toBe(0);
    expect(countMentionTokens('')).toBe(0);
  });
});
