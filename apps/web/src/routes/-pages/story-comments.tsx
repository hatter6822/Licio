// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Focused story comment reader. The story page preserves article reading width
// with one inline reply layer; this page gives discussion more horizontal space
// and lets readers traverse deeper branches two visual layers at a time.
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { CommentSection } from '../../components/comments/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useT } from '../../i18n/index.js';
import { useStoryQuery } from '../../lib/queries.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

function StoryCommentsContent({
  storyId,
  rootContributionId,
}: {
  storyId: string;
  rootContributionId?: string | undefined;
}): React.ReactElement {
  const t = useT();
  const story = useStoryQuery(storyId);
  return (
    <PageScaffold title={t('comments.title', 'Conversation')} query={story}>
      {(data) => (
        <main
          className="mx-auto flex w-full max-w-4xl flex-col gap-4"
          aria-labelledby="comment-page-heading"
        >
          <div className="flex flex-col gap-2">
            <Link
              to="/stories/$storyId"
              params={{ storyId }}
              hash="comments"
              className="w-fit text-sm font-medium text-primary-on-soft underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              ← Back to story comments
            </Link>
            <p className="text-sm text-ink-muted">Focused discussion for</p>
            <h1 id="comment-page-heading" className="text-3xl font-semibold text-ink">
              {data.title}
            </h1>
          </div>
          {data.thread_id ? (
            <CommentSection
              storyId={data.story_id}
              threadId={data.thread_id}
              surface="conversation"
              rootContributionId={rootContributionId}
            />
          ) : (
            <ErrorState
              title="Conversation unavailable"
              description="This story does not have an attached discussion thread."
            />
          )}
        </main>
      )}
    </PageScaffold>
  );
}

export function StoryCommentsPage(): React.ReactElement {
  const t = useT();
  const { storyId } = useParams({ from: '/stories_/$storyId_/comments' });
  const { root } = useSearch({ from: '/stories_/$storyId_/comments' });
  usePageFocus(t('comments.title', 'Conversation'));

  if (!isValidUuidParam(storyId)) {
    return (
      <>
        <PageHeader title={t('comments.title', 'Conversation')} />
        <div className="mx-auto w-full max-w-3xl p-4">
          <ErrorState
            title={t('story.invalid.title', 'This link is not valid')}
            description={t('story.invalid.description', 'The story address is malformed.')}
          />
        </div>
      </>
    );
  }

  return <StoryCommentsContent storyId={storyId} rootContributionId={root} />;
}
