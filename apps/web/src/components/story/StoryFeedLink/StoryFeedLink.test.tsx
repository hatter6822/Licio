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
  it('never nests the source link inside the discussion link (no <a> in <a>)', () => {
    const { container } = renderItem(
      feedItem({ url: 'https://example.org/health/readmissions-q1' }),
    );
    // The exact defect reported: an anchor descending from another anchor.
    expect(container.querySelector('a a')).toBeNull();
  });

  it('exposes two distinct links: the card opens the discussion, the title opens the source', () => {
    renderItem(feedItem({ url: 'https://example.org/health/readmissions-q1' }));
    // The stretched overlay → discussion (distinct accessible name).
    expect(screen.getByRole('link', { name: /open the discussion for/i })).toHaveAttribute(
      'href',
      '/stories/$storyId',
    );
    // The title → external source.
    expect(
      screen.getByRole('link', {
        name: 'River levels stabilize after upstream coordination',
      }),
    ).toHaveAttribute('href', 'https://example.org/health/readmissions-q1');
  });

  it('still wraps the card in a discussion link when the item has no source URL', () => {
    renderItem(feedItem({})); // no url → StoryCard renders the title as plain text
    expect(
      screen.queryByRole('link', {
        name: 'River levels stabilize after upstream coordination',
      }),
    ).toBeNull();
    expect(screen.getByRole('link', { name: /open the discussion for/i })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderItem(feedItem({ url: 'https://example.org/x' }));
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
