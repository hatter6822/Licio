// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story detail (WS-C.1.1b). Type-safe `storyId` param (invalid UUIDs render an
// error state rather than fetching). Mounting the story marks it the active item
// for the signal processor; opening the in-app reader records a source-open
// (WS-C.4.2). Source content is rendered by the sandboxed WS-B.2.7 reader.
import type { StoryDetail, TopicRepeatPreference } from '@licio/shared';
import { TOPIC_REPEAT_PREFERENCES } from '@licio/shared';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { SourceReader } from '../../components/reader/SourceReader/index.js';
import { IndependentSourcesDrawer } from '../../components/story/IndependentSourcesDrawer/index.js';
import { ShareStoryButton } from '../../components/story/ShareStoryButton/index.js';
import { WhereInterpretationsDiffer } from '../../components/story/WhereInterpretationsDiffer/index.js';
import { Button } from '../../components/ui/Button/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { NarrowLoopPrompt } from '../../components/wellbeing/NarrowLoopPrompt/index.js';
import { useT } from '../../i18n/index.js';
import {
  useIndependentSourcesQuery,
  useSavedStoriesQuery,
  useStoryInterpretationsQuery,
  useStoryQuery,
  useToggleSavedStoryMutation,
  useUpdateDurablePrivacyMutation,
} from '../../lib/queries.js';
import { markTopicQuiet } from '../../offline/notification-meter.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { getSignalProcessor } from '../../signals/runtime.js';
import { getTopicLoopTracker } from '../../signals/topic-loops.js';
import { useAuthStore } from '../../stores/auth.js';
import { useUIStore } from '../../stores/ui.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

/** Toggle whether a story is saved for offline reading (WS-C.2.2a). */
function SaveStoryButton({ story }: { story: StoryDetail }): React.ReactElement {
  const t = useT();
  const saved = useSavedStoriesQuery();
  const toggle = useToggleSavedStoryMutation();
  const isSaved = saved.data?.some((record) => record.storyId === story.story_id) ?? false;
  return (
    <Button
      variant="secondary"
      aria-pressed={isSaved}
      disabled={toggle.isPending}
      onClick={() =>
        toggle.mutate(
          isSaved ? { action: 'unsave', storyId: story.story_id } : { action: 'save', story },
        )
      }
    >
      {isSaved ? t('story.saved', 'Saved for offline') : t('story.save', 'Save for offline')}
    </Button>
  );
}

/**
 * Per-topic repeats preference (WS-H.2.3c, SPEC §7.6): "show fewer repeats" /
 * "balanced" / "show all updates" for THIS story's topic, persisted in the
 * durable personalization settings (consumed by ranking once WS-I lands).
 * Signed-in only — the preference must survive sessions and devices.
 */
function TopicRepeatsPreference({ topicId }: { topicId: string }): React.ReactElement | null {
  const t = useT();
  const authenticated = useAuthStore((state) => state.status === 'authenticated');
  const updateDurable = useUpdateDurablePrivacyMutation();
  const [value, setValue] = useState<TopicRepeatPreference>('balanced');
  if (!authenticated) return null;
  const labels: Record<TopicRepeatPreference, string> = {
    fewer_repeats: t('repeats.fewer', 'Show fewer repeats'),
    balanced: t('repeats.balanced', 'Balanced'),
    show_all: t('repeats.showAll', 'Show all updates'),
  };
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
      <span>{t('repeats.label', 'Repeats on this topic')}</span>
      <select
        className="rounded-md border border-edge bg-surface px-2 py-1 text-xs text-ink"
        value={value}
        onChange={(event) => {
          const next = event.target.value as TopicRepeatPreference;
          setValue(next);
          updateDurable.mutate({
            personalization_settings: { topic_repeat_preference: { [topicId]: next } },
          });
        }}
      >
        {TOPIC_REPEAT_PREFERENCES.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </label>
  );
}

function StoryDetailContent({ storyId }: { storyId: string }): React.ReactElement {
  const t = useT();
  const story = useStoryQuery(storyId);
  const interpretations = useStoryInterpretationsQuery(storyId);
  const independentSources = useIndependentSourcesQuery(storyId);
  const [readerOpen, setReaderOpen] = useState(false);
  const [loopPromptDismissed, setLoopPromptDismissed] = useState(false);
  const openId = useRef(`source-${storyId}`);
  const navigate = useNavigate();
  const setFeedMode = useUIStore((state) => state.setFeedMode);
  const authenticated = useAuthStore((state) => state.status === 'authenticated');
  const updateDurable = useUpdateDurablePrivacyMutation();

  // Mark this story the active item for dwell/return tracking while it is open.
  useEffect(() => {
    const processor = getSignalProcessor();
    processor.setActiveStory(storyId);
    return () => {
      processor.setActiveStory(null);
      void processor.flush();
    };
  }, [storyId]);

  // PHI v0 (WS-H.6.1a/b): record the TOPIC-CLUSTER visit in the in-browser
  // session sequence (topic ids + timing only — never the story id).
  const topicIds = story.data?.topic_ids;
  useEffect(() => {
    const firstTopic = topicIds?.[0];
    if (firstTopic) getTopicLoopTracker().recordVisit(firstTopic);
  }, [topicIds]);
  const assessment = getTopicLoopTracker().assess();
  const loopDetected = !loopPromptDismissed && assessment.narrowLoop.detected;
  // Quiet-notification policy (WS-H.6.1c): a flagged topic's pushes show
  // silently for a while — never a buzz that reinforces the loop.
  const loopedTopic = assessment.narrowLoop.topicClusterId;
  useEffect(() => {
    if (loopedTopic) void markTopicQuiet(loopedTopic);
  }, [loopedTopic]);
  const broadenFeed = (): void => {
    // "See broader context": switch to the source-diverse feed mode and go
    // there — a soft, reversible intervention (SPEC §11.6). Signed in, the
    // mode also persists across sessions/devices (WS-H.6.1c-2).
    setFeedMode('source-diverse');
    if (authenticated) {
      updateDurable.mutate({ personalization_settings: { feed_mode: 'source-diverse' } });
    }
    void navigate({ to: '/', search: { mode: 'source-diverse' } });
  };

  const openReader = (): void => {
    getSignalProcessor().recordSourceOpen(openId.current, storyId);
    setReaderOpen(true);
  };
  const closeReader = (): void => {
    getSignalProcessor().recordSourceClose(openId.current);
    setReaderOpen(false);
  };

  return (
    <PageScaffold title={story.data?.title ?? t('story.title', 'Story')} query={story}>
      {(data) =>
        readerOpen && data.url ? (
          <SourceReader url={data.url} title={data.title} onClose={closeReader} />
        ) : (
          <article className="flex flex-col gap-4">
            {loopDetected ? (
              <NarrowLoopPrompt
                onSeeBroader={broadenFeed}
                onDismiss={() => setLoopPromptDismissed(true)}
              />
            ) : null}
            <p className="text-sm text-ink-muted">{data.source}</p>
            <p className="text-base text-ink">{data.body_summary}</p>
            <div className="flex flex-wrap gap-2">
              {data.url ? (
                <Button variant="primary" onClick={openReader}>
                  {t('story.readSource', 'Read source')}
                </Button>
              ) : null}
              <SaveStoryButton story={data} />
              <ShareStoryButton
                title={data.title}
                url={typeof window !== 'undefined' ? window.location.href : ''}
                needsContext={interpretations.data?.needs_context ?? false}
              />
            </div>
            {topicIds?.[0] ? <TopicRepeatsPreference topicId={topicIds[0]} /> : null}
            {interpretations.data ? (
              <WhereInterpretationsDiffer data={interpretations.data} />
            ) : null}
            {independentSources.data ? (
              <IndependentSourcesDrawer data={independentSources.data} />
            ) : null}
          </article>
        )
      }
    </PageScaffold>
  );
}

export function StoryDetailPage(): React.ReactElement {
  const t = useT();
  const { storyId } = useParams({ from: '/stories/$storyId' });
  usePageFocus(t('story.title', 'Story'));

  if (!isValidUuidParam(storyId)) {
    return (
      <>
        <PageHeader title={t('story.title', 'Story')} />
        <div className="mx-auto w-full max-w-2xl p-4">
          <ErrorState
            title={t('story.invalid.title', 'This link is not valid')}
            description={t('story.invalid.description', 'The story address is malformed.')}
          />
        </div>
      </>
    );
  }
  return <StoryDetailContent storyId={storyId} />;
}
