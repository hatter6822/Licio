// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dedicated story conversation surface. It preserves the story-internal comment
// landing area while giving comment reading a wider, branch-oriented page.
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { CommentSection } from '../../components/comments/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useT } from '../../i18n/index.js';
import { useStoryQuery } from '../../lib/queries.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

function StoryCommentsContent({ storyId, root }: { storyId: string; root?: string }) {
  const story = useStoryQuery(storyId);
  const t = useT();
  return (
    <PageScaffold
      title={t('story.comments.title', 'Conversation')}
      query={story}
      contentClassName="max-w-3xl"
    >
      {(data) => (
        <main className="flex w-full flex-col gap-4">
          <nav aria-label="Conversation navigation" className="text-sm">
            <Link
              to="/stories/$storyId"
              params={{ storyId }}
              hash="comments"
              className="font-medium text-primary-on-soft underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              ← Back to the story comment landing section
            </Link>
          </nav>
          <div className="flex flex-col gap-1">
            <p className="text-sm text-ink-muted">Comment-focused view</p>
            <h1 className="text-3xl font-semibold text-ink">{data.title}</h1>
            <p className="text-sm text-ink-muted">
              Follow branches two layers at a time. Use “Show more replies” on any branch to keep
              going deeper, or return to the top-level conversation at any point.
            </p>
          </div>
          {data.thread_id ? (
            <CommentSection
              storyId={data.story_id}
              threadId={data.thread_id}
              visualReplyDepth={2}
              {...(root ? { rootContributionId: root } : {})}
              focused
            />
          ) : (
            <ErrorState
              title="Conversation unavailable"
              description="This story does not have an attached comment thread."
            />
          )}
        </main>
      )}
    </PageScaffold>
  );
}

export function StoryCommentsPage(): React.ReactElement {
  const t = useT();
  const { storyId } = useParams({ from: '/stories/$storyId_/comments' });
  const { root } = useSearch({ from: '/stories/$storyId_/comments' });
  usePageFocus(t('story.comments.title', 'Conversation'));

  if (!isValidUuidParam(storyId)) {
    return (
      <>
        <PageHeader title={t('story.comments.title', 'Conversation')} />
        <div className="mx-auto w-full max-w-2xl p-4">
          <ErrorState
            title={t('story.invalid.title', 'This link is not valid')}
            description={t('story.invalid.description', 'The story address is malformed.')}
          />
        </div>
      </>
    );
  }

  return <StoryCommentsContent storyId={storyId} {...(root ? { root } : {})} />;
}
