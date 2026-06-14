// SPDX-License-Identifier: AGPL-3.0-or-later
//
// StoryFeedLink — the feed-card link wrapper shared by the front page, the topic
// surface, and room feeds. The WHOLE card — title included — opens the story
// detail (the discussion) through a single "stretched" overlay link; the source
// URL is reached from the story page's in-app reader, so the card carries no
// competing inner link.
//
// Why an overlay SIBLING and not an <a> WRAPPING the card:
//   1. Accessibility — the overlay's accessible name is just the title, so the
//      card reads as one concise link, not a giant link folding in every line
//      of card text (source, rating, reason, chips, estimate).
//   2. Safety — the card is never a DESCENDANT of the link, so an inner anchor
//      can never nest inside it. (The original defect was a route <a> wrapping
//      StoryCard, whose title was itself an <a>: "<a> cannot be a descendant of
//      <a>", a React hydration error.) This is the standard "stretched link"
//      pattern (cf. Bootstrap .stretched-link).
import type { FeedItem } from '@licio/shared';
import { Link } from '@tanstack/react-router';
import { useT } from '../../../i18n/index.js';
import { feedItemToCard } from '../feed-card.js';
import { StoryCard } from '../StoryCard/index.js';

export function StoryFeedLink({ item }: { item: FeedItem }): React.ReactElement {
  const t = useT();
  return (
    <li className="relative">
      {/* The stretched overlay covers the whole card and opens the discussion;
          its accessible name is the story title, so the card reads as a single
          concise "Open the discussion for …" link. */}
      <Link
        to="/stories/$storyId"
        params={{ storyId: item.story_id }}
        aria-label={t('feed.openDiscussion', 'Open the discussion for {title}', {
          title: item.title,
        })}
        className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <StoryCard {...feedItemToCard(item)} />
    </li>
  );
}
