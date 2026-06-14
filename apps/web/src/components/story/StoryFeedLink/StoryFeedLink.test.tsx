// SPDX-License-Identifier: AGPL-3.0-or-later
//
// StoryFeedLink wraps a StoryCard so the whole card opens the discussion while
// the title's source link stays clickable — WITHOUT nesting <a> inside <a>
// (invalid HTML that React reports as a hydration error). These tests pin that
// structural invariant and the two-distinct-links behaviour.
import type { FeedItem } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { StoryFeedLink } from './StoryFeedLink.js';

// Render the router Link as a real anchor whose href reflects `to`, forwarding
// the a11y-relevant props so the assertions exercise the real link structure.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode;
    to?: string;
    className?: string;
    'aria-label'?: string;
  }) => (
    <a href={to ?? '#'} className={className} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));

function feedItem(over: Partial<FeedItem>): FeedItem {
  return {
    story_id: '5f5e1000-0000-4000-8000-000000000004',
    title: 'River levels stabilize after upstream coordination',
    source: 'Delta Observer',
    origin: 'independent',
    reading_minutes: 4,
    rating_label: 'well-sourced',
    distribution_reason: 'Rising from independent source opens',
    context_chips: [],
    safety_state: 'ok',
    exposure_label: null,
    more_on_this_story: [],
    context_card: null,
    ...over,
  } as FeedItem;
}

function renderItem(item: FeedItem) {
  // StoryFeedLink renders an <li>; a <ul> parent keeps the markup valid.
  return render(
    <ul className="flex flex-col gap-3">
      <StoryFeedLink item={item} />
    </ul>,
  );
}

describe('StoryFeedLink', () => {
  it('opens the discussion for the whole card without wrapping it (no <a> in <a>)', () => {
    const { container } = renderItem(
      feedItem({ url: 'https://example.org/health/readmissions-q1' }),
    );
    // No anchor may descend from another (the reported hydration defect)...
    expect(container.querySelector('a a')).toBeNull();
    // ...and the discussion link must not WRAP the card content either.
    const link = screen.getByRole('link', { name: /open the discussion for/i });
    expect(link).toHaveAttribute('href', '/stories/$storyId');
    expect(link.querySelector('article')).toBeNull();
  });

  it('routes the title to the discussion too — the card has no separate source link', () => {
    renderItem(feedItem({ url: 'https://example.org/health/readmissions-q1' }));
    // The ONLY link is the discussion overlay; the title is plain heading text.
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(
      screen.queryByRole('link', {
        name: 'River levels stabilize after upstream coordination',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('heading', {
        name: 'River levels stabilize after upstream coordination',
      }),
    ).toBeInTheDocument();
  });

  it('wraps the card in the discussion link regardless of a source URL', () => {
    renderItem(feedItem({})); // no url
    expect(screen.getByRole('link', { name: /open the discussion for/i })).toHaveAttribute(
      'href',
      '/stories/$storyId',
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = renderItem(feedItem({ url: 'https://example.org/x' }));
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
