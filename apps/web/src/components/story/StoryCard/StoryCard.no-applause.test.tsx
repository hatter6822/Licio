// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dedicated no-applause verification (WS-B.2.1b / Sections 2.4, 5.1, 6.3).
// Defense in depth with the type system in types.ts: a future refactor cannot
// silently reintroduce an applause affordance without failing this suite.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Story, StoryCardData } from '../types.js';
import { StoryCard } from './StoryCard.js';

const sample: StoryCardData = {
  story: {
    id: 's1',
    title: 'River levels stabilize after upstream coordination',
    source: 'Delta Observer',
    origin: 'independent',
    url: 'https://example.org/story',
    readingMinutes: 4,
  },
  ratingLabel: 'bridge-active',
  distributionReason: 'Multiple communities are engaging with improving coherence',
  contextChips: [
    { id: 'c1', label: '3 lenses' },
    { id: 'c2', label: '2 primary sources' },
  ],
  branchPreview: [{ id: 'b1', title: 'What changed upstream?' }],
};

// Forbidden-pattern matrix (WS-B.2.1b). Word-boundary matched against rendered
// text so legitimate words ("read", "source") are never false positives.
const FORBIDDEN_TEXT =
  /\b(likes?|upvotes?|downvotes?|votes?|reactions?|karma|followers?|"?\d+ (likes|votes|reactions)"?)\b/i;

const FORBIDDEN_TESTIDS = [
  'like',
  'vote',
  'upvote',
  'downvote',
  'reaction',
  'karma',
  'follower',
  'score',
];

// Compile-time audit: these aliases fail `tsc` if any forbidden key is added.
type ForbiddenCountKey =
  | 'likeCount'
  | 'likes'
  | 'votes'
  | 'voteCount'
  | 'upvotes'
  | 'downvotes'
  | 'score'
  | 'reactions'
  | 'reactionCount'
  | 'karma'
  | 'followerCount'
  | 'shareCount'
  | 'starRating';
const noApplauseStory: Extract<keyof Story, ForbiddenCountKey> extends never ? true : never = true;
const noApplauseData: Extract<keyof StoryCardData, ForbiddenCountKey> extends never ? true : never =
  true;

describe('StoryCard no-applause guarantee (WS-B.2.1b)', () => {
  it('renders zero applause affordances (text matrix)', () => {
    const { container } = render(
      <StoryCard
        {...sample}
        onSave={() => undefined}
        onOpenContext={() => undefined}
        onMore={() => undefined}
      />,
    );
    expect(container.textContent ?? '').not.toMatch(FORBIDDEN_TEXT);
  });

  it('renders no elements with applause-related test ids or roles', () => {
    const { container } = render(<StoryCard {...sample} />);
    for (const id of FORBIDDEN_TESTIDS) {
      expect(container.querySelector(`[data-testid*="${id}" i]`)).toBeNull();
    }
    // No star/heart/thumb iconography anywhere in the card.
    expect(container.querySelector('[aria-label*="like" i]')).toBeNull();
    expect(container.querySelector('[aria-label*="vote" i]')).toBeNull();
  });

  it('a feed of cards contains zero applause affordances across all cards', () => {
    const { container } = render(
      <div>
        {[0, 1, 2].map((n) => (
          <StoryCard key={n} {...sample} story={{ ...sample.story, id: `s${n}` }} />
        ))}
      </div>,
    );
    expect(container.textContent ?? '').not.toMatch(FORBIDDEN_TEXT);
  });

  it('the Story and StoryCardData types expose no applause fields (type-level audit)', () => {
    expect(noApplauseStory).toBe(true);
    expect(noApplauseData).toBe(true);
  });
});
