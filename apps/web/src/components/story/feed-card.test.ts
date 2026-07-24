// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FeedItem → StoryCardData mapping (feed-card.ts): the WS-T dispute posture and
// the terminal settle marker project onto the card view-model as presence
// fields — absent when there is nothing to say, so a quiet story carries no
// dispute presentation at all.
import { feedItemSchema } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { feedItemToCard } from './feed-card.js';

const base = feedItemSchema.parse({
  story_id: '00000000-0000-4000-8000-000000000f01',
  title: 'A story that has weathered every challenge',
  source: 'example.gov',
  reading_minutes: 4,
});

describe('feedItemToCard — dispute + settle projection', () => {
  it('omits both dispute fields on an undisputed item', () => {
    const card = feedItemToCard(base);
    expect(card.disputeStatus).toBeUndefined();
    expect(card.disputeSettled).toBeUndefined();
  });

  it('carries disputeStatus for a live/decided dispute without settling', () => {
    const card = feedItemToCard({ ...base, dispute_status: 'under_debate' });
    expect(card.disputeStatus).toBe('under_debate');
    expect(card.disputeSettled).toBeUndefined();
  });

  it('carries the settle marker when the wire sets dispute_settled', () => {
    // A settled story is always `validated` on the wire; the card threads both.
    const card = feedItemToCard({ ...base, dispute_status: 'validated', dispute_settled: true });
    expect(card.disputeStatus).toBe('validated');
    expect(card.disputeSettled).toBe(true);
  });
});
