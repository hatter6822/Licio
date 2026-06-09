// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story detail (WS-C.1.1b). Type-safe `storyId` param (invalid UUIDs render an
// error state rather than fetching). Mounting the story marks it the active item
// for the signal processor; opening the in-app reader records a source-open
// (WS-C.4.2). Source content is rendered by the sandboxed WS-B.2.7 reader.
import { useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { SourceReader } from '../../components/reader/SourceReader/index.js';
import { Button } from '../../components/ui/Button/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useT } from '../../i18n/index.js';
import { useStoryQuery } from '../../lib/queries.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { getSignalProcessor } from '../../signals/runtime.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

function StoryDetailContent({ storyId }: { storyId: string }): React.ReactElement {
  const t = useT();
  const story = useStoryQuery(storyId);
  const [readerOpen, setReaderOpen] = useState(false);
  const openId = useRef(`source-${storyId}`);

  // Mark this story the active item for dwell/return tracking while it is open.
  useEffect(() => {
    const processor = getSignalProcessor();
    processor.setActiveStory(storyId);
    return () => {
      processor.setActiveStory(null);
      void processor.flush();
    };
  }, [storyId]);

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
            <p className="text-sm text-ink-muted">{data.source}</p>
            <p className="text-base text-ink">{data.body_summary}</p>
            {data.url ? (
              <div>
                <Button variant="primary" onClick={openReader}>
                  {t('story.readSource', 'Read source')}
                </Button>
              </div>
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
