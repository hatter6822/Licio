// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CommentItem } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  byParticipationDesc,
  commentParticipationWeight,
  SOURCED_PARTICIPATION_BONUS,
} from './comment-participation.js';

function comment(over: Partial<CommentItem> & { contribution_id: string }): CommentItem {
  return {
    thread_id: '22222222-2222-4222-8222-222222222222',
    type: 'comment',
    body: 'A comment.',
    citations: [],
    metadata: {},
    target_claim_id: null,
    parent_contribution_id: null,
    author_handle: 'alice',
    author_display_name: 'Alice',
    is_author: false,
    created_at: '2026-06-18T00:00:00.000Z',
    updated_at: '2026-06-18T00:00:00.000Z',
    edited: false,
    depth: 0,
    child_count: 0,
    moderation_state: 'published',
    dispute_status: 'none',
    active_debate_id: null,
    media: [],
    replies: [],
    reply_count: 0,
    has_more_replies: false,
    ...over,
  };
}

describe('comment participation weight (WS-E.2.1c / WS-T)', () => {
  it('gives a sourced comment more participation than an unsourced one', () => {
    const unsourced = comment({ contribution_id: 'a' });
    const sourced = comment({
      contribution_id: 'b',
      citations: [{ url: 'https://example.org/x' }],
    });
    expect(commentParticipationWeight(unsourced)).toBe(1);
    expect(commentParticipationWeight(sourced)).toBe(1 + SOURCED_PARTICIPATION_BONUS);
    expect(commentParticipationWeight(sourced)).toBeGreaterThan(
      commentParticipationWeight(unsourced),
    );
  });

  it('sinks a debate-loser below every live comment', () => {
    const loser = comment({ contribution_id: 'c', dispute_status: 'incorrect' });
    const live = comment({ contribution_id: 'd' });
    expect(commentParticipationWeight(loser)).toBeLessThan(commentParticipationWeight(live));
  });

  it('orders sourced → unsourced → debate-loser, stable within ties', () => {
    const unsourced1 = comment({ contribution_id: 'u1', body: 'u1' });
    const sourced = comment({
      contribution_id: 's',
      body: 's',
      citations: [{ url: 'https://example.org/x' }],
    });
    const unsourced2 = comment({ contribution_id: 'u2', body: 'u2' });
    const loser = comment({ contribution_id: 'l', body: 'l', dispute_status: 'incorrect' });
    const ordered = byParticipationDesc([unsourced1, sourced, unsourced2, loser]);
    expect(ordered.map((c) => c.contribution_id)).toEqual(['s', 'u1', 'u2', 'l']);
  });

  it('does not mutate the input array', () => {
    const input = [comment({ contribution_id: 'a' }), comment({ contribution_id: 'b' })];
    const copy = [...input];
    byParticipationDesc(input);
    expect(input).toEqual(copy);
  });
});
