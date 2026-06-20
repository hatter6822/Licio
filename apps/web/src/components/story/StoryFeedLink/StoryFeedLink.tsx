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
//
// Two controls sit ABOVE the overlay link (z-10) so they stay independently
// operable: the Report affordance (WS-J.1.1, top-right → the shared ReportSheet)
// and the per-topic repeats preference (WS-H.2.3c, bottom-right → a compact
// sheet; signed-in readers on topic-tagged stories only).
import type { FeedItem } from '@licio/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { ReportSheet } from '../../safety/ReportSheet.js';
import { Icon } from '../../ui/Icon/index.js';
import { feedItemToCard } from '../feed-card.js';
import { StoryCard } from '../StoryCard/index.js';
import { TopicRepeatsButton } from '../TopicRepeatsButton/index.js';

export function StoryFeedLink({ item }: { item: FeedItem }): React.ReactElement {
  const t = useT();
  const [reportOpen, setReportOpen] = useState(false);
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
      {/* Stacked above the overlay (z-10) so it is independently operable. */}
      <button
        type="button"
        onClick={() => setReportOpen(true)}
        aria-label={t('feed.reportStory', 'Report this story')}
        className="absolute end-2 top-2 z-10 inline-flex h-12 w-12 items-center justify-center rounded-full text-ink-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <Icon name="flag" />
      </button>
      <StoryCard {...feedItemToCard(item)} />
      {/* WS-H.2.3c — the per-topic "repeats" preference, stacked above the
          overlay (z-10) in the card's bottom-right corner so it is independently
          operable. Renders only for a signed-in reader on a topic-tagged story. */}
      {item.topic_ids[0] ? (
        <TopicRepeatsButton topicId={item.topic_ids[0]} className="absolute end-2 bottom-2 z-10" />
      ) : null}
      {reportOpen ? (
        <ReportSheet
          open
          onClose={() => setReportOpen(false)}
          targetType="content"
          targetId={item.story_id}
          contentKind="story"
        />
      ) : null}
    </li>
  );
}
