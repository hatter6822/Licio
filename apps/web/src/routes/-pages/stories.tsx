// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story detail (WS-C.1.1b). Type-safe `storyId` param (invalid UUIDs render an
// error state rather than fetching). Mounting the story marks it the active item
// for the signal processor; opening the in-app reader records a source-open
// (WS-C.4.2). Source content is rendered by the sandboxed WS-B.2.7 reader.
import { isSentinelTopicId, type StoryDetail } from '@licio/shared';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { CommentSection, CorrectionComposer } from '../../components/comments/index.js';
import { SourceReader } from '../../components/reader/SourceReader/index.js';
import { ReportButton } from '../../components/safety/ReportSheet.js';
import { AuthorVisibilityControl } from '../../components/story/AuthorVisibilityControl/index.js';
import { ShareStoryButton } from '../../components/story/ShareStoryButton/index.js';
import { StoryMedia } from '../../components/story/StoryMedia/index.js';
import { WhereInterpretationsDiffer } from '../../components/story/WhereInterpretationsDiffer/index.js';
import { Button } from '../../components/ui/Button/index.js';
import { Dialog } from '../../components/ui/Dialog/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { Icon } from '../../components/ui/Icon/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useGoBack } from '../../hooks/useGoBack.js';
import { useT } from '../../i18n/index.js';
import {
  useSavedStoriesQuery,
  useStoryInterpretationsQuery,
  useStoryQuery,
  useToggleSavedStoryMutation,
} from '../../lib/queries.js';
import { markTopicQuiet } from '../../offline/notification-meter.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { getSignalProcessor } from '../../signals/runtime.js';
import { getTopicLoopTracker } from '../../signals/topic-loops.js';
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

/** Raise a sourced correction against the STORY itself (WS-T story-root
 *  challenge) — opens the debate arena on success. */
function StoryCorrectionButton({
  storyId,
  threadId,
}: {
  storyId: string;
  threadId: string;
}): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <Button variant="secondary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="pencil" className="size-4" aria-hidden />
        {t('story.correct', 'Correct')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('story.correct.title', 'Correct this story')}
      >
        <CorrectionComposer
          storyId={storyId}
          threadId={threadId}
          target={{ storyRoot: true }}
          onCancel={() => setOpen(false)}
          onOpened={(debateId) => {
            setOpen(false);
            void navigate({
              to: '/stories/$storyId/debate/$debateId',
              params: { storyId, debateId },
            });
          }}
        />
      </Dialog>
    </>
  );
}

function StoryDetailContent({ storyId }: { storyId: string }): React.ReactElement {
  const t = useT();
  const story = useStoryQuery(storyId);
  const interpretations = useStoryInterpretationsQuery(storyId);
  const [readerOpen, setReaderOpen] = useState(false);
  const openId = useRef(`source-${storyId}`);
  const navigate = useNavigate();
  // Return to wherever the story was opened from (front page, topic, room); a
  // cold-loaded deep link falls back (replacing) to the front page.
  const goBack = useGoBack(() => void navigate({ to: '/', replace: true }));

  // Mark this story the active item for dwell/return tracking while it is open.
  // Leaving captures its §22.1 aggregate on the "done attending" boundary; the
  // buffered batch is uploaded on the processor's interval, never eagerly per
  // navigation (WS-C.4.4: batched at intervals, not per interaction).
  useEffect(() => {
    const processor = getSignalProcessor();
    processor.setActiveStory(storyId);
    return () => {
      processor.setActiveStory(null);
    };
  }, [storyId]);

  // PHI v0 (WS-H.6.1a/b, SPEC §11.6): record the TOPIC-CLUSTER visit in the
  // in-browser session sequence (topic ids + timing only — never the story id).
  // This feeds the CLIENT-SIDE topic-frequency dampener (the front page shows a
  // circled topic steadily less often, down to a floor — the quiet replacement
  // for the old interrupting prompt) and the quiet-notification policy below.
  const topicIds = story.data?.topic_ids;
  // The story's own TRUSTED primary topic — but never the UNCLASSIFIED sentinel
  // (an unclassified story has no real topic, so it must not contribute to the
  // circling signal, which would falsely read as "circling one topic").
  const primaryTopic =
    topicIds?.[0] !== undefined && !isSentinelTopicId(topicIds[0]) ? topicIds[0] : null;
  useEffect(() => {
    if (primaryTopic !== null) getTopicLoopTracker().recordVisit(primaryTopic);
  }, [primaryTopic]);
  // Quiet-notification policy (WS-H.6.1c): once a topic is being circled enough,
  // its pushes show silently for a while — never a buzz that reinforces the loop.
  useEffect(() => {
    if (primaryTopic !== null && getTopicLoopTracker().isCircling(primaryTopic)) {
      void markTopicQuiet(primaryTopic);
    }
  }, [primaryTopic]);

  const openReader = (): void => {
    getSignalProcessor().recordSourceOpen(openId.current, storyId);
    setReaderOpen(true);
  };
  const closeReader = (): void => {
    getSignalProcessor().recordSourceClose(openId.current);
    setReaderOpen(false);
  };

  return (
    <PageScaffold
      title={story.data?.title ?? t('story.title', 'Story')}
      onBack={goBack}
      query={story}
    >
      {(data) =>
        readerOpen && data.url ? (
          <SourceReader url={data.url} title={data.title} onClose={closeReader} />
        ) : (
          <article className="flex flex-col gap-4">
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
              {/* WS-T — raise a sourced correction against the story (opens a debate). */}
              {data.thread_id ? (
                <StoryCorrectionButton storyId={data.story_id} threadId={data.thread_id} />
              ) : null}
              {/* WS-J.1.1 — report this story (the two-tap sheet). */}
              <ReportButton targetType="content" targetId={data.story_id} contentKind="story" />
            </div>
            {/* WS-T.7 — the conversation now lives inline on the story page as a
                lightly nested comment section; /threads deep links remain only
                as backwards-compatible redirects/read shells. */}
            {data.thread_id ? (
              <CommentSection
                storyId={data.story_id}
                threadId={data.thread_id}
                {...(data.room_id ? { roomId: data.room_id } : {})}
              />
            ) : null}
            {/* WS-Q.5.4a — the author's visibility control (owner only). */}
            {data.is_owner ? (
              <AuthorVisibilityControl
                storyId={data.story_id}
                visibility={data.visibility ?? 'public'}
                {...(data.room_visibility ? { roomVisibility: data.room_visibility } : {})}
              />
            ) : null}
            {interpretations.data ? (
              <WhereInterpretationsDiffer data={interpretations.data} storyId={storyId} />
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
