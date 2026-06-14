// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story detail (WS-C.1.1b). Type-safe `storyId` param (invalid UUIDs render an
// error state rather than fetching). Mounting the story marks it the active item
// for the signal processor; opening the in-app reader records a source-open
// (WS-C.4.2). Source content is rendered by the sandboxed WS-B.2.7 reader.
import type { StoryDetail } from '@licio/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { SourceReader } from '../../components/reader/SourceReader/index.js';
import { AuthorVisibilityControl } from '../../components/story/AuthorVisibilityControl/index.js';
import { IndependentSourcesDrawer } from '../../components/story/IndependentSourcesDrawer/index.js';
import { ShareStoryButton } from '../../components/story/ShareStoryButton/index.js';
import { StoryMedia } from '../../components/story/StoryMedia/index.js';
import { TopicRepeatsPreference } from '../../components/story/TopicRepeatsPreference/index.js';
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
  // session sequence (topic ids + timing only — never the story id), then
  // RE-ASSESS in the same effect — assessment lives in state so the visit
  // that crosses the narrow-loop threshold triggers the prompt and the
  // quiet-notification write immediately, not on a later re-render.
  const topicIds = story.data?.topic_ids;
  const [assessment, setAssessment] = useState(() => getTopicLoopTracker().assess());
  useEffect(() => {
    const tracker = getTopicLoopTracker();
    const firstTopic = topicIds?.[0];
    if (firstTopic) tracker.recordVisit(firstTopic);
    setAssessment(tracker.assess());
  }, [topicIds]);
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
            {/* WS-I.2.6b: the specific distribution reason, with the link
                into the reader's OWN Signal Ledger for deep inspection
                (SPEC §13.5 — explanations are inspectable, never vague). */}
            <div className="flex flex-col gap-1">
              <p className="text-sm text-ink">{data.distribution_reason}</p>
              <Link
                to="/profile/signal-ledger"
                className="text-sm text-primary-on-soft underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {t('story.inspectSignals', 'Inspect your reading signals')}
              </Link>
            </div>
            {data.media ? (
              <StoryMedia
                url={data.media.url}
                kind={data.media.kind}
                altText={data.media.alt_text}
                captionsText={data.media.captions_text}
                captionsUrl={data.media.captions_url}
                posterUrl={data.media.poster_url}
              />
            ) : null}
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
                contextStatusPending={interpretations.isPending}
              />
            </div>
            {/* WS-Q.5.4a — the author's visibility control (owner only). */}
            {data.is_owner ? (
              <AuthorVisibilityControl
                storyId={data.story_id}
                visibility={data.visibility ?? 'public'}
                {...(data.room_visibility ? { roomVisibility: data.room_visibility } : {})}
              />
            ) : null}
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
