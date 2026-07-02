// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7.2 dedicated comment-centric page (`/stories/$storyId/comments`).  This
// surface contains ONLY comments — no story body, media, or sidebars — so the
// reading area is maximal.  It renders up to TWO nested reply layers and lets a
// reader drill arbitrarily deep by re-rooting at any comment (`?root=`).  The
// page header's upper-left back button RETRACES history (`useGoBack`), so it
// returns the reader to exactly where they came from — the story page if they
// opened a thread from it, or the previous drill-down level if they walked
// deeper here — never a fixed hard-navigate that would ping-pong with the story
// page's own history-back button.  Structural jumps stay one tap away: the
// "Up one level" / "All comments" breadcrumbs re-root the drill-down, and the
// story-title line links straight to the story.  In the focused (rooted) view
// the anchor's replies nest INSIDE its article for a tighter reading column.
import type { CommentItem } from '@licio/shared';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useSpaFocus } from '../../components/a11y/index.js';
import {
  CommentComposer,
  CommentHeader,
  CommentMedia,
  CommentNode,
  commentActionClass,
} from '../../components/comments/index.js';
import { UgcBody } from '../../components/ugc/UgcBody.js';
import { Button } from '../../components/ui/Button/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { Icon } from '../../components/ui/Icon/index.js';
import { LoadingState } from '../../components/ui/LoadingState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useGoBack } from '../../hooks/useGoBack.js';
import { useT } from '../../i18n/index.js';
import { cn } from '../../lib/cn.js';
import { useStoryCommentsQuery, useStoryQuery } from '../../lib/queries.js';
import { raisedSurface } from '../../lib/surfaces.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { getSignalProcessor } from '../../signals/runtime.js';

/** Unrooted "all comments" view: two nested reply layers per top-level comment. */
const ALL_COMMENTS_DEPTH = 2;
/** Focused view: the anchor header + one nested layer of its replies (= two
 *  layers of comments below the anchor). */
const FOCUSED_DEPTH = 1;

/** The focused comment: a context header (the "Replying within" tile) whose
 *  replies — this level's comment list — nest INSIDE its article for a tighter
 *  reading column (WS-T.7.2), rather than sitting in a separate sibling article.
 *  Replying on the anchor itself adds a direct reply. */
function AnchorComment({
  storyId,
  anchor,
  children,
}: {
  storyId: string;
  anchor: CommentItem;
  /** This level's comments (the anchor's replies), nested inside the article. */
  children: React.ReactNode;
}): React.ReactElement {
  const [replying, setReplying] = useState(false);
  return (
    <article
      // A surface-tinted raised tile (vs. the canvas-filled reply tiles) plus the
      // "Replying within" label sets the focused anchor apart from its replies.
      className={cn(raisedSurface, 'flex flex-col gap-3 bg-surface p-3')}
      aria-label="Focused comment"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Replying within</p>
      <CommentHeader comment={anchor} />
      {anchor.body.length > 0 ? <UgcBody markdown={anchor.body} compact /> : null}
      <CommentMedia comment={anchor} />
      <div className="-ml-1.5">
        <button
          type="button"
          className={commentActionClass}
          aria-expanded={replying}
          onClick={() => setReplying((value) => !value)}
        >
          Reply
        </button>
      </div>
      {replying ? (
        <CommentComposer
          storyId={storyId}
          threadId={anchor.thread_id}
          parentContributionId={anchor.contribution_id}
          onCancel={() => setReplying(false)}
        />
      ) : null}
      {/* This level's comments nest here, inside the anchor's article. */}
      {children}
    </article>
  );
}

/** Drill-down breadcrumbs for the focused (rooted) view: "All comments" and,
 *  for a reply, "Up one level" — the structural jumps between drill-down levels.
 *  Jumping straight to the story is the story-title line's link below, and the
 *  page-header back button retraces history, so neither is duplicated here.  The
 *  unrooted view has no drill-down, so this renders nothing. */
function Breadcrumbs({
  storyId,
  anchor,
}: {
  storyId: string;
  anchor: CommentItem | null;
}): React.ReactElement | null {
  if (!anchor) return null;
  const linkClass =
    'inline-flex items-center gap-1 text-sm font-medium text-primary-on-soft underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
  return (
    <nav className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Comment navigation">
      <Link to="/stories/$storyId/comments" params={{ storyId }} search={{}} className={linkClass}>
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

  // Mark this story the active item so deep-thread reading on THIS dedicated
  // page records the §5.3 reply-depth traversal: CommentNode calls
  // recordReplyDepth(storyId, depth), and the §22.1 aggregate — with the max
  // depth reached — is captured on the "done attending" boundary when the reader
  // leaves. Without a current item, captureCurrent() emits nothing, so traversal
  // (now a scored ActiveAttention dimension) would be dropped here.
  //
  // `recordVisit: false` — this is a WITHIN-STORY hop from the story page, not a
  // return from time away, so it must not add a return visit (a reader who
  // dwelt >30 min on the story body before opening comments would otherwise be
  // scored a spurious return).
  useEffect(() => {
    const processor = getSignalProcessor();
    processor.setActiveStory(storyId, { recordVisit: false });
    return () => {
      processor.setActiveStory(null);
    };
  }, [storyId]);

  const isRooted = root !== undefined;
  const depth = isRooted ? FOCUSED_DEPTH : ALL_COMMENTS_DEPTH;
  const comments = useStoryCommentsQuery(
    storyId,
    isRooted ? { root, depth: FOCUSED_DEPTH } : { depth: ALL_COMMENTS_DEPTH },
  );

  // Retrace history so the back button returns the reader to exactly where they
  // came from (the story page, or the previous drill-down level); a cold-loaded
  // deep link falls back (replacing) to the story's comment section.
  const goBack = useGoBack(
    () =>
      void navigate({
        to: '/stories/$storyId',
        params: { storyId },
        hash: 'comments',
        replace: true,
      }),
  );

  const anchor = comments.data?.anchor ?? null;
  const list = comments.data?.comments ?? [];
  const threadId = story.data?.thread_id ?? anchor?.thread_id ?? list[0]?.thread_id ?? null;
  const storyTitle = story.data?.title ?? null;

  // This level's comments + the load-more control, rendered EITHER nested inside
  // the focused anchor's article (rooted view) or as the page's top-level list
  // (unrooted view).
  const listAndMore = (
    <>
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
  );

  return (
    <>
      <PageHeader title={t('comments.title', 'Comments')} onBack={goBack} />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        <Breadcrumbs storyId={storyId} anchor={anchor} />
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
        ) : isRooted ? (
          // Focused view: this level's comments nest INSIDE the anchor's article
          // (a tighter reading column) rather than as separate sibling articles.
          anchor ? (
            <AnchorComment storyId={storyId} anchor={anchor}>
              {listAndMore}
            </AnchorComment>
          ) : (
            listAndMore
          )
        ) : (
          <>
            {/* A top-level composer for the unrooted view; the focused view's
                composer lives on the anchor (a reply to it). */}
            {threadId ? <CommentComposer storyId={storyId} threadId={threadId} /> : null}
            {listAndMore}
          </>
        )}
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
