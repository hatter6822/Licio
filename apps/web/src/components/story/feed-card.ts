// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FeedItem → StoryCardData (the presentation view-model). Shared by the front
// page, topic surface, and room feed so media (WS-Q.5.2c) and the in-room chip
// (WS-Q.5.3b) project identically everywhere. No-applause-safe by construction:
// it carries no count/score field (the types forbid them).
import type { FeedItem } from '@licio/shared';
import { type IconName, iconNames } from '../ui/Icon/index.js';
import type { StoryCardData } from './types.js';

function asIconName(value: string | undefined): IconName | undefined {
  return value !== undefined && (iconNames as readonly string[]).includes(value)
    ? (value as IconName)
    : undefined;
}

/** Map a wire feed item to the card view-model. On a room feed, a `room_only`
 *  item gets the in-room chip; public items never do. */
export function feedItemToCard(item: FeedItem): StoryCardData {
  return {
    story: {
      id: item.story_id,
      title: item.title,
      source: item.source,
      ...(item.url ? { url: item.url } : {}),
      readingMinutes: item.reading_minutes,
    },
    sourcesCount: item.sources_count,
    corrections: item.corrections,
    ...(item.safety_state !== 'ok' ? { safetyState: item.safety_state } : {}),
    ...(item.dispute_status !== 'none' ? { disputeStatus: item.dispute_status } : {}),
    distributionReason: item.distribution_reason,
    contextChips: item.context_chips.map((chip) => {
      const icon = asIconName(chip.icon);
      return { id: chip.id, label: chip.label, ...(icon ? { icon } : {}) };
    }),
    ...(item.visibility === 'room_only' ? { inRoom: true } : {}),
    ...(item.media
      ? {
          media: {
            url: item.media.url,
            kind: item.media.kind,
            altText: item.media.alt_text,
            captionsText: item.media.captions_text,
            captionsUrl: item.media.captions_url,
            posterUrl: item.media.poster_url,
          },
        }
      : {}),
  };
}
