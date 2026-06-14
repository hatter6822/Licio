// SPDX-License-Identifier: AGPL-3.0-or-later
//
// StoryFeedLink — the feed-card link wrapper shared by the front page, the topic
// surface, and room feeds. The WHOLE card opens the story detail (the
// discussion) through a "stretched" overlay link, while the card's own title
// link (to the external source) stays clickable above it (the title carries
// `relative z-10` inside StoryCard).
//
// Why an overlay SIBLING and not an <a> WRAPPING the card: StoryCard's title is
// itself an <a> (→ source). Wrapping the card in the detail <a> would nest one
// anchor inside another — invalid HTML that React reports as a hydration error
// ("In HTML, <a> cannot be a descendant of <a>" / "<a> cannot contain a nested
// <a>"). The overlay sits beside the card instead, so the two links never nest.
// This is the standard "stretched link" pattern (cf. Bootstrap .stretched-link).
import type { FeedItem } from '@licio/shared';
import { Link } from '@tanstack/react-router';
import { useT } from '../../../i18n/index.js';
import { feedItemToCard } from '../feed-card.js';
import { StoryCard } from '../StoryCard/index.js';

export function StoryFeedLink({ item }: { item: FeedItem }): React.ReactElement {
  const t = useT();
  return (
    <li className="relative">
      {/* The stretched overlay covers the whole card and opens the discussion.
          Its accessible name is deliberately DISTINCT from the title's source
          link, so screen readers announce two clearly different destinations
          (card → discussion, title → source) rather than two same-named links. */}
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
