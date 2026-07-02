// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7 inline story comment section.  Comments render through the sanctioned
// UGC sink and stay strictly no-applause (no likes, votes, counters-as-reactions,
// or popularity affordances).  The section shows up to TWO nested reply layers
// inline (parent → reply → reply-to-reply); a thread that continues deeper — or a
// comment with more direct replies than are shown — links into the dedicated
// comment-centric page (`/stories/$storyId/comments`, re-rooted at that comment)
// via each comment's "Continue this thread" / "Show all replies" link.  More
// TOP-LEVEL comments load in place ("Load more comments") — there is no separate
// "show more" jump that duplicated the per-thread continuation.
import { useMemo, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useCommentStream } from '../../lib/comment-stream.js';
import { useStoryCommentsQuery } from '../../lib/queries.js';
import { raisedInteractive, raisedSurface } from '../../lib/surfaces.js';
import { UgcBody } from '../ugc/UgcBody.js';
import { Button } from '../ui/Button/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { Icon } from '../ui/Icon/index.js';
import { CommentNode } from './CommentNode.js';
import { CommentComposer } from './CommentParts.js';

export interface CommentSectionProps {
  storyId: string;
  threadId: string;
}

type CommentFilter = 'all' | 'sources' | 'corrections';

/** The inline section renders up to two nested reply layers (parent → reply →
 *  reply-to-reply); anything deeper links into the dedicated comment page. */
const INLINE_MAX_DEPTH = 2;

export function CommentSection({ storyId, threadId }: CommentSectionProps): React.ReactElement {
  const [filter, setFilter] = useState<CommentFilter>('all');
  const comments = useStoryCommentsQuery(
    storyId,
    filter === 'all' ? { depth: INLINE_MAX_DEPTH } : { filter, depth: INLINE_MAX_DEPTH },
  );
  const stream = useCommentStream(storyId);
  const options = useMemo(
    () => [
      { id: 'all' as const, label: 'All' },
      { id: 'sources' as const, label: 'Sources' },
      { id: 'corrections' as const, label: 'Corrections' },
    ],
    [],
  );

  const visible = comments.data?.comments ?? [];

  return (
    <section id="comments" className="mt-6 flex flex-col gap-4" aria-labelledby="comments-heading">
      <div className="flex flex-col gap-2">
        <h2 id="comments-heading" className="text-2xl font-semibold text-ink">
          Conversation
        </h2>
        <p className="text-sm text-ink-muted">
          Comments are weighted by context, evidence, and reply depth — never by applause.
        </p>
      </div>
      {comments.data?.summary ? (
        <aside className={cn('p-4', raisedSurface)} aria-label="Conversation overview">
          <h3 className="font-semibold text-ink">Overview</h3>
          <UgcBody markdown={comments.data.summary.body} compact />
        </aside>
      ) : null}
      <CommentComposer storyId={storyId} threadId={threadId} />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Comment filters">
        {options.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant={filter === option.id ? 'primary' : 'secondary'}
            aria-pressed={filter === option.id}
            onClick={() => setFilter(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {stream.newComments.length > 0 ? (
        <button
          type="button"
          className={cn(
            'flex items-center justify-center gap-2 p-3 text-primary-on-soft',
            raisedSurface,
            raisedInteractive,
          )}
          onClick={() => {
            stream.drain();
            void comments.refetch();
          }}
        >
          <Icon name="refresh" className="size-5" />
          Show {stream.newComments.length} new comment{stream.newComments.length === 1 ? '' : 's'}
        </button>
      ) : null}
      {comments.isError ? (
        <ErrorState
          title="Comments unavailable"
          description="The conversation could not be loaded."
        />
      ) : comments.isLoading ? (
        <p className="text-sm text-ink-muted">Loading comments…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-md border border-line p-4 text-sm text-ink-muted">
          No comments yet. Start the conversation with context or a source.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((comment) => (
            <CommentNode
              key={comment.contribution_id}
              storyId={storyId}
              comment={comment}
              depthInView={0}
              maxDepthInView={INLINE_MAX_DEPTH}
            />
          ))}
        </div>
      )}
      {/* More TOP-LEVEL comments than the first page — appended in place. Deeper
          replies are reached per-thread via each comment's "Continue" link, so
          this never duplicates that continuation. */}
      {comments.hasMore ? (
        <Button
          type="button"
          variant="secondary"
          loading={comments.isFetchingMore}
          onClick={() => comments.loadMore()}
        >
          Load more comments
        </Button>
      ) : null}
    </section>
  );
}
