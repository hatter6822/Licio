// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Front Page (WS-C.1.1a landing route, eager). Ranked feed of stories/discussions
// with the no-applause feed-mode switcher (WS-B.2.9) wired to the UI store and a
// shareable `?mode=` search param. Each card links to the story detail.
import type { FeedItem, FeedMode } from '@licio/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { DiminishingReturnsPrompt } from '../../components/feed/DiminishingReturnsPrompt/DiminishingReturnsPrompt.js';
import { FeedModeSwitcher } from '../../components/feed/FeedModeSwitcher/index.js';
import { SectionEndpoint } from '../../components/feed/SectionEndpoint/index.js';
import { SearchButton } from '../../components/search/SearchButton/index.js';
import { StoryFeedLink } from '../../components/story/StoryFeedLink/index.js';
import { BrandLogo } from '../../components/ui/BrandLogo/index.js';
import { useT } from '../../i18n/index.js';
import { useFeedQuery, useUpdateDurablePrivacyMutation } from '../../lib/queries.js';
import { dampenFeed } from '../../signals/topic-dampening.js';
import { getTopicLoopTracker } from '../../signals/topic-loops.js';
import { useAuthStore, useUIStore } from '../../stores/index.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

/**
 * WS-Q.5.4b — the empty-state copy is the front page's only self-description
 * (the ranked feed speaks for itself; explanatory framing chrome was removed).
 * Deliberately free of any applause vocabulary (no likes/votes/upvotes/karma);
 * the front-page-copy no-applause test pins this.
 */
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
  // Flatten the infinite pages; adapt to the PageScaffold's single-query shape.
  const items: FeedItem[] = feed.data?.pages.flatMap((page) => page.items) ?? [];
  // PHI v0 (WS-H.6.1c, SPEC §11.6): quietly show a topic the reader is CIRCLING
  // less often — down to a non-zero floor, so a pursued topic still surfaces
  // rarely — instead of interrupting with a prompt. The circling signal is
  // browser-only (topic ids + timing); this reshapes only what THIS device
  // renders, never what the server ranks, and it recovers when the reader moves
  // on. Recomputed each render so it tracks the latest in-session circling.
  //
  // Dampening is PERSONALIZATION — it applies only to `best` (the default
  // attention-ranked feed, where the anti-rabbit-hole nudge belongs). Every
  // other mode is an explicit COMPLETE sort the reader chose (`new`, `sources`,
  // `debates`, `rising` — the server serves the whole ordering): thinning it
  // locally would corrupt the requested order and silently skip items from the
  // server-decision cursor chain on the next page.
  const personalized = mode === 'best';
  const displayItems = personalized
    ? dampenFeed(items, getTopicLoopTracker().topicMultipliers())
    : items;
  const feedQuery = {
    data: feed.data === undefined ? undefined : displayItems,
    isLoading: feed.isLoading,
    isError: feed.isError,
    refetch: feed.refetch,
  };

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
        // The search button stands in for the visible title (the brand mark +
        // nav state already name this page); the sr-only <h1> keeps the
        // accessible heading and the WS-B.1.6 focus target — see PageHeader.
        titleReplacement={<SearchButton />}
        actions={<FeedModeSwitcher value={mode} onValueChange={onModeChange} />}
        query={feedQuery}
        isEmpty={(data) => data.length === 0}
        emptyTitle={t('feed.empty.title', 'No stories yet')}
        emptyDescription={t('feed.empty.description', FRONT_PAGE_EMPTY_DESCRIPTION)}
      >
        {(data) => (
          <ul className="flex flex-col gap-3">
            {data.map((item) => (
              <StoryFeedLink key={item.story_id} item={item} />
            ))}
            {/* WS-B.2.8b — continuation is an EXPLICIT reader choice: the next
                page (lower-confidence / more-repetitive by ranking order) loads
                ONLY on pressing the prompt, never from scrolling (§13.6). */}
            {feed.hasNextPage ? (
              <li>
                <DiminishingReturnsPrompt
                  onContinue={() => {
                    if (!feed.isFetchingNextPage) void feed.fetchNextPage();
                  }}
                  {...(feed.isFetchingNextPage
                    ? { continueLabel: t('feed.loadingMore', 'Loading…') }
                    : {})}
                />
              </li>
            ) : (
              // WS-B.2.8a — a calm end marker when there is no next page (never
              // an infinite scroll); the prior behaviour rendered nothing.
              <li>
                <SectionEndpoint />
              </li>
            )}
          </ul>
        )}
      </PageScaffold>
    </>
  );
}
