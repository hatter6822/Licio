// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Front Page (WS-C.1.1a landing route, eager). Ranked feed of stories/discussions
// with the no-applause feed-mode switcher (WS-B.2.9) wired to the UI store and a
// shareable `?mode=` search param. Each card links to the story detail.
import type { FeedItem, FeedMode } from '@licio/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { FeedModeSwitcher } from '../../components/feed/FeedModeSwitcher/index.js';
import { StoryCard } from '../../components/story/StoryCard/index.js';
import type { StoryCardData } from '../../components/story/types.js';
import { type IconName, iconNames } from '../../components/ui/Icon/index.js';
import { useT } from '../../i18n/index.js';
import { useFeedQuery, useUpdateDurablePrivacyMutation } from '../../lib/queries.js';
import { useAuthStore, useUIStore } from '../../stores/index.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

function asIconName(value: string | undefined): IconName | undefined {
  return value && (iconNames as readonly string[]).includes(value)
    ? (value as IconName)
    : undefined;
}

/** Map the validated wire FeedItem to the WS-B StoryCard presentation props. */
function toStoryCardData(item: FeedItem): StoryCardData {
  return {
    story: {
      id: item.story_id,
      title: item.title,
      source: item.source,
      origin: item.origin,
      ...(item.url ? { url: item.url } : {}),
      readingMinutes: item.reading_minutes,
    },
    ratingLabel: item.rating_label,
    ...(item.exposure_label ? { exposureLabel: item.exposure_label } : {}),
    distributionReason: item.distribution_reason,
    contextChips: item.context_chips.map((chip) => {
      const icon = asIconName(chip.icon);
      return { id: chip.id, label: chip.label, ...(icon ? { icon } : {}) };
    }),
    ...(item.media
      ? {
          media: {
            uploadRef: item.media.upload_ref,
            kind: item.media.kind,
            altText: item.media.alt_text,
            captionsText: item.media.captions_text,
          },
        }
      : {}),
  };
}

export function FrontPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.frontPage', 'Front Page'));
  const navigate = useNavigate();
  const search = useSearch({ from: '/' });
  const savedMode = useUIStore((state) => state.feedMode);
  const setFeedMode = useUIStore((state) => state.setFeedMode);
  // The URL wins when present (shareable); otherwise the reader's saved mode.
  const mode = search.mode ?? savedMode;
  const feed = useFeedQuery(mode);

  const authenticated = useAuthStore((state) => state.status === 'authenticated');
  const updateDurable = useUpdateDurablePrivacyMutation();
  const onModeChange = (next: FeedMode): void => {
    setFeedMode(next);
    // WS-H.6.1c-2: the mode persists across sessions AND devices — sync the
    // durable personalization settings best-effort when signed in (the
    // local store keeps working offline/anonymous).
    if (authenticated) {
      updateDurable.mutate({ personalization_settings: { feed_mode: next } });
    }
    void navigate({ to: '/', search: { mode: next } });
  };

  return (
    <PageScaffold
      title={t('nav.frontPage', 'Front Page')}
      actions={<FeedModeSwitcher value={mode} onValueChange={onModeChange} />}
      query={feed}
      isEmpty={(data) => data.items.length === 0}
      emptyTitle={t('feed.empty.title', 'No stories yet')}
      emptyDescription={t(
        'feed.empty.description',
        'When stories arrive, the most thoughtfully discussed appear here — never the most liked.',
      )}
    >
      {(data) => (
        <ul className="flex flex-col gap-3">
          {data.items.map((item) => (
            <li key={item.story_id}>
              <Link
                to="/stories/$storyId"
                params={{ storyId: item.story_id }}
                className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <StoryCard {...toStoryCardData(item)} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageScaffold>
  );
}
