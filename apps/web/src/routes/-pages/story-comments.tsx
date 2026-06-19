// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7.2 dedicated comment-centric page (`/stories/$storyId/comments`).  This
// surface contains ONLY comments — no story body, media, or sidebars — so the
// reading area is maximal.  It renders up to TWO nested reply layers and lets a
// reader drill arbitrarily deep by re-rooting at any comment (`?root=`), while a
// persistent "Back to the story" control and an up-one-level breadcrumb always
// return them to the original story-page comment section.
import type { CommentItem } from '@licio/shared';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useSpaFocus } from '../../components/a11y/index.js';
import {
  CommentComposer,
  CommentHeader,
  CommentMedia,
  CommentNode,
} from '../../components/comments/index.js';
import { UgcBody } from '../../components/ugc/UgcBody.js';
import { Button } from '../../components/ui/Button/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { Icon } from '../../components/ui/Icon/index.js';
import { LoadingState } from '../../components/ui/LoadingState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useT } from '../../i18n/index.js';
import { cn } from '../../lib/cn.js';
import { useStoryCommentsQuery, useStoryQuery } from '../../lib/queries.js';
import { raisedInteractive, raisedSurface } from '../../lib/surfaces.js';
import { isValidUuidParam } from '../../routing/guards.js';

/** Unrooted "all comments" view: two nested reply layers per top-level comment. */
const ALL_COMMENTS_DEPTH = 2;
/** Focused view: the anchor header + one nested layer of its replies (= two
 *  layers of comments below the anchor). */
const FOCUSED_DEPTH = 1;

/** The focused comment, rendered as a read-only context header above its replies
 *  (which are the page's comment list).  Replying here adds a direct reply. */
function AnchorComment({
  storyId,
  anchor,
}: {
  storyId: string;
  anchor: CommentItem;
}): React.ReactElement {
  const [replying, setReplying] = useState(false);
  return (
    <article
      className={cn('flex flex-col gap-3 border-primary/40 p-4', raisedSurface)}
      aria-label="Focused comment"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Replying within</p>
      <CommentHeader comment={anchor} />
      {anchor.body.length > 0 ? <UgcBody markdown={anchor.body} compact /> : null}
      <CommentMedia comment={anchor} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" onClick={() => setReplying((value) => !value)}>
          Reply
        </Button>
      </div>
      {replying ? (
        <CommentComposer
          storyId={storyId}
          threadId={anchor.thread_id}
          parentContributionId={anchor.contribution_id}
          onCancel={() => setReplying(false)}
        />
      ) : null}
    </article>
  );
}

function Breadcrumbs({
  storyId,
  anchor,
  onBackToStory,
}: {
  storyId: string;
  anchor: CommentItem | null;
  onBackToStory: () => void;
}): React.ReactElement {
  const linkClass =
    'inline-flex items-center gap-1 text-sm font-medium text-primary-on-soft underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
  return (
    <nav className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Comment navigation">
      <button type="button" className={linkClass} onClick={onBackToStory}>
        <Icon name="arrow-left" className="size-4" aria-hidden />
        Back to the story
      </button>
      {anchor ? (
        <>
          <span className="text-ink-muted" aria-hidden>
            ·
          </span>
          <Link
            to="/stories/$storyId/comments"
            params={{ storyId }}
            search={{}}
            className={linkClass}
          >
            All comments
          </Link>
          {/* Only a reply has somewhere to go "up" to; for a top-level anchor,
              "All comments" above already IS the parent level. */}
          {anchor.parent_contribution_id ? (
            <>
              <span className="text-ink-muted" aria-hidden>
                ·
              </span>
              <Link
                to="/stories/$storyId/comments"
                params={{ storyId }}
                search={{ root: anchor.parent_contribution_id }}
                className={linkClass}
              >
                <Icon name="chevron-up" className="size-4" aria-hidden />
                Up one level
              </Link>
            </>
          ) : null}
        </>
      ) : null}
    </nav>
  );
}

function StoryCommentsContent({
  storyId,
  root,
}: {
  storyId: string;
  root: string | undefined;
}): React.ReactElement {
  const t = useT();
  const navigate = useNavigate();
  const story = useStoryQuery(storyId);
  const isRooted = root !== undefined;
  const depth = isRooted ? FOCUSED_DEPTH : ALL_COMMENTS_DEPTH;
  const comments = useStoryCommentsQuery(
    storyId,
    isRooted ? { root, depth: FOCUSED_DEPTH } : { depth: ALL_COMMENTS_DEPTH },
  );

  const backToStory = (): void => {
    void navigate({ to: '/stories/$storyId', params: { storyId }, hash: 'comments' });
  };

  const anchor = comments.data?.anchor ?? null;
  const list = comments.data?.comments ?? [];
  const threadId = story.data?.thread_id ?? anchor?.thread_id ?? list[0]?.thread_id ?? null;
  const storyTitle = story.data?.title ?? null;

  return (
    <>
      <PageHeader title={t('comments.title', 'Comments')} onBack={backToStory} />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        <Breadcrumbs storyId={storyId} anchor={anchor} onBackToStory={backToStory} />
        {storyTitle ? (
          <p className="text-sm text-ink-muted">
            {isRooted
              ? t('comments.focused.on', 'A thread on')
              : t('comments.all.on', 'The full conversation on')}{' '}
            <Link
              to="/stories/$storyId"
              params={{ storyId }}
              className="font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {storyTitle}
            </Link>
          </p>
        ) : null}

        {comments.isError ? (
          <ErrorState
            title={t('comments.error.title', 'Conversation unavailable')}
            description={t(
              'comments.error.description',
              'This comment thread is unavailable or you do not have permission to read it.',
            )}
          />
        ) : comments.isLoading ? (
          <LoadingState />
        ) : (
          <>
            {isRooted && anchor ? <AnchorComment storyId={storyId} anchor={anchor} /> : null}
            {/* A top-level composer for the unrooted view; the focused view's
                composer lives on the anchor (a reply to it). */}
            {!isRooted && threadId ? (
              <CommentComposer storyId={storyId} threadId={threadId} />
            ) : null}
            {list.length === 0 ? (
              <p className="rounded-md border border-line p-4 text-sm text-ink-muted">
                {isRooted
                  ? t('comments.focused.empty', 'No replies yet. Be the first to respond.')
                  : t(
                      'comments.all.empty',
                      'No comments yet. Start the conversation with context or a source.',
                    )}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {list.map((comment) => (
                  <CommentNode
                    key={comment.contribution_id}
                    storyId={storyId}
                    comment={comment}
                    depthInView={0}
                    maxDepthInView={depth}
                  />
                ))}
              </div>
            )}
            {comments.hasMore ? (
              <Button
                type="button"
                variant="secondary"
                loading={comments.isFetchingMore}
                onClick={() => comments.loadMore()}
              >
                {isRooted
                  ? t('comments.loadMoreReplies', 'Load more replies')
                  : t('comments.loadMore', 'Load more comments')}
              </Button>
            ) : null}
          </>
        )}

        {/* The always-available return to the original story-page comment section. */}
        <Link
          to="/stories/$storyId"
          params={{ storyId }}
          hash="comments"
          className={cn(
            'flex items-center justify-center gap-2 p-3 text-sm font-medium text-primary-on-soft',
            raisedSurface,
            raisedInteractive,
          )}
        >
          <Icon name="arrow-left" className="size-4" aria-hidden />
          {t('comments.backToStory', 'Back to the story')}
        </Link>
      </div>
    </>
  );
}

export function StoryCommentsPage(): React.ReactElement {
  const t = useT();
  const { storyId } = useParams({ from: '/stories/$storyId_/comments' });
  const { root } = useSearch({ from: '/stories/$storyId_/comments' });
  // Re-key focus/announcement on the drill-down anchor so each re-root moves
  // focus to the heading and announces the view (search-only nav otherwise
  // leaves focus stranded).
  useSpaFocus(`/stories/${storyId}/comments?root=${root ?? ''}`, t('comments.title', 'Comments'));

  if (!isValidUuidParam(storyId)) {
    return (
      <>
        <PageHeader title={t('comments.title', 'Comments')} />
        <div className="mx-auto w-full max-w-3xl p-4">
          <ErrorState
            title={t('story.invalid.title', 'This link is not valid')}
            description={t('story.invalid.description', 'The story address is malformed.')}
          />
        </div>
      </>
    );
  }
  return <StoryCommentsContent storyId={storyId} root={root} />;
}
