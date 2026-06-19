// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7 inline story comment section.  Comments render through the sanctioned
// UGC sink and stay strictly no-applause (no likes, votes, counters-as-reactions,
// or popularity affordances).  To protect the story's reading area this section
// shows ONLY ONE nested reply layer; deeper threads — and the full conversation —
// open in the dedicated comment-centric page (`/stories/$storyId/comments`) via
// the per-thread "continue" links and the section-level "Show more" entry.
import { Link } from '@tanstack/react-router';
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

/** The inline section renders exactly one nested reply layer. */
const INLINE_MAX_DEPTH = 1;

export function CommentSection({ storyId, threadId }: CommentSectionProps): React.ReactElement {
  const [filter, setFilter] = useState<CommentFilter>('all');
  const comments = useStoryCommentsQuery(storyId, filter === 'all' ? {} : { filter });
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
  // There is "more to see" when more top-level comments remain unfetched OR any
  // shown thread continues past the single inline layer.
  const hasDeeperThreads = visible.some(
    (comment) => comment.has_more_replies || comment.reply_count > 0,
  );
  const showFullConversation = comments.hasMore || hasDeeperThreads;

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
      {/* The "Show more" entry into the comment-centric reading page (WS-T.7.2):
          comments only, two nested layers, with deeper drill-down. */}
      {showFullConversation ? (
        <Link
          to="/stories/$storyId/comments"
          params={{ storyId }}
          search={{}}
          className={cn(
            'flex items-center justify-center gap-2 p-3 text-base font-semibold text-primary-on-soft',
            raisedSurface,
            raisedInteractive,
          )}
        >
          Show more comments
          <Icon name="chevron-right" className="size-5" aria-hidden />
        </Link>
      ) : null}
    </section>
  );
}
