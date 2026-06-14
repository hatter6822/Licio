// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Front Page (WS-C.1.1a landing route, eager). Ranked feed of stories/discussions
// with the no-applause feed-mode switcher (WS-B.2.9) wired to the UI store and a
// shareable `?mode=` search param. Each card links to the story detail.
import type { FeedMode } from '@licio/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { FeedModeSwitcher } from '../../components/feed/FeedModeSwitcher/index.js';
import { StoryFeedLink } from '../../components/story/StoryFeedLink/index.js';
import { BrandLogo } from '../../components/ui/BrandLogo/index.js';
import { useT } from '../../i18n/index.js';
import { useFeedQuery, useUpdateDurablePrivacyMutation } from '../../lib/queries.js';
import { useAuthStore, useUIStore } from '../../stores/index.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

/**
 * WS-Q.5.4b — front-page framing. The front page shows PUBLIC stories earning
 * the most meaningful, participation-weighted attention — never popularity.
 * Deliberately free of any applause vocabulary (no likes/votes/upvotes/karma);
 * the FRONT_PAGE_COPY no-applause test pins this.
 */
export const FRONT_PAGE_FRAMING =
  'Public stories earning the most meaningful, participation-weighted attention — never by popularity.';
export const FRONT_PAGE_EMPTY_DESCRIPTION =
  'When stories arrive, the most thoughtfully discussed appear here — ranked by participation-weighted attention, never by popularity.';

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
    <>
      {/* Brand presence on the mobile landing screen; the desktop side rail
          carries the logo at lg+, so this is hidden there to avoid duplication. */}
      <div className="flex justify-center pt-4 lg:hidden">
        <Link
          to="/"
          className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <BrandLogo className="h-12" priority />
        </Link>
      </div>
      <PageScaffold
        title={t('nav.frontPage', 'Front Page')}
        actions={<FeedModeSwitcher value={mode} onValueChange={onModeChange} />}
        query={feed}
        isEmpty={(data) => data.items.length === 0}
        emptyTitle={t('feed.empty.title', 'No stories yet')}
        emptyDescription={t('feed.empty.description', FRONT_PAGE_EMPTY_DESCRIPTION)}
      >
        {(data) => (
          <ul className="flex flex-col gap-3">
            <li>
              <p className="text-ink-muted text-sm">{t('feed.framing', FRONT_PAGE_FRAMING)}</p>
            </li>
            {data.items.map((item) => (
              <StoryFeedLink key={item.story_id} item={item} />
            ))}
          </ul>
        )}
      </PageScaffold>
    </>
  );
}
