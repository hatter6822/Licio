// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7 embedded story comment section. Comments render through the sanctioned
// UGC sink, use the shared comment write contract, and stay strictly no-applause:
// no likes, votes, counters-as-reactions, or popularity affordances.
import type { CommentItem as CommentItemType, ContributionWriteCreate } from '@licio/shared';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useCommentStream } from '../../lib/comment-stream.js';
import { useCreateCommentMutation, useStoryCommentsQuery } from '../../lib/queries.js';
import { raisedInteractive, raisedSurface } from '../../lib/surfaces.js';
import { getSignalProcessor } from '../../signals/runtime.js';
import { UgcBody } from '../ugc/UgcBody.js';
import { Button } from '../ui/Button/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { Icon } from '../ui/Icon/index.js';

export interface CommentSectionProps {
  storyId: string;
  threadId: string;
}

type CommentFilter = 'all' | 'sources' | 'corrections';

function authorName(comment: CommentItemType): string {
  return comment.author_display_name ?? comment.author_handle ?? 'Deleted account';
}

function mediaUrl(url: string): string {
  if (/^https?:\/\//u.test(url)) return url;
  return url;
}

function CommentMedia({ comment }: { comment: CommentItemType }): React.ReactElement | null {
  const media = comment.media ?? [];
  if (media.length === 0) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {media.map((item) => (
        <figure
          key={item.upload_id}
          className="overflow-hidden rounded-md border border-line bg-surface"
        >
          <img
            src={mediaUrl(item.url)}
            alt={item.alt_text}
            loading="lazy"
            decoding="async"
            className={cn(
              'max-h-96 w-full object-contain',
              item.animatable && 'motion-reduce:hidden',
            )}
          />
          {item.animatable ? (
            <figcaption className="hidden p-2 text-sm text-ink-muted motion-reduce:block">
              Animated GIF hidden because reduced motion is enabled.{' '}
              <a
                href={mediaUrl(item.url)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline"
              >
                Open the GIF deliberately
              </a>
              .
            </figcaption>
          ) : null}
        </figure>
      ))}
    </div>
  );
}

function CommentComposer({
  storyId,
  threadId,
  parentContributionId,
  onCancel,
}: {
  storyId: string;
  threadId: string;
  parentContributionId?: string;
  onCancel?: () => void;
}): React.ReactElement {
  const [body, setBody] = useState('');
  const mutation = useCreateCommentMutation(storyId);
  const trimmed = body.trim();
  const submit = (): void => {
    if (trimmed.length === 0 || mutation.isPending) return;
    const payload: ContributionWriteCreate = {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: crypto.randomUUID(),
      body: trimmed,
      ...(parentContributionId ? { parent_contribution_id: parentContributionId } : {}),
    };
    mutation.mutate(payload, {
      onSuccess: () => {
        setBody('');
        onCancel?.();
      },
    });
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label
        className="sr-only"
        htmlFor={parentContributionId ? `reply-${parentContributionId}` : 'comment-body'}
      >
        {parentContributionId ? 'Write a reply' : 'Write a comment'}
      </label>
      <textarea
        id={parentContributionId ? `reply-${parentContributionId}` : 'comment-body'}
        value={body}
        maxLength={5000}
        onChange={(event) => setBody(event.currentTarget.value)}
        placeholder={parentContributionId ? 'Reply with context…' : 'Add a comment with context…'}
        className="min-h-28 rounded-md border border-line bg-surface p-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">{trimmed.length}/5000 characters</p>
        <div className="flex gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            loading={mutation.isPending}
            disabled={trimmed.length === 0}
          >
            {parentContributionId ? 'Reply' : 'Comment'}
          </Button>
        </div>
      </div>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-error">
          Comment could not be posted. Please try again.
        </p>
      ) : null}
    </form>
  );
}

function CommentItem({
  storyId,
  comment,
  depth = comment.depth,
}: {
  storyId: string;
  comment: CommentItemType;
  depth?: number;
}): React.ReactElement {
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const expandedReplies = useStoryCommentsQuery(storyId, { root: comment.contribution_id });
  const loadedReplies = (expandedReplies.data?.comments ?? []).filter(
    (reply) => reply.contribution_id !== comment.contribution_id,
  );
  const visibleReplies =
    expanded && loadedReplies.length > comment.replies.length ? loadedReplies : comment.replies;
  useEffect(() => {
    getSignalProcessor().recordReplyDepth(storyId, depth);
  }, [storyId, depth]);
  return (
    <article className={cn('flex flex-col gap-3 p-4', raisedSurface)}>
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-ink">{authorName(comment)}</p>
          <time dateTime={comment.created_at} className="text-sm text-ink-muted">
            {new Date(comment.created_at).toLocaleString()}
          </time>
        </div>
        {comment.type === 'evidence' || comment.type === 'correction' ? (
          <span className="rounded-full border border-line px-2 py-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
            {comment.type === 'evidence' ? 'Source' : 'Correction'}
          </span>
        ) : null}
      </header>
      {comment.body.length > 0 ? <UgcBody markdown={comment.body} compact /> : null}
      <CommentMedia comment={comment} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" onClick={() => setReplying((value) => !value)}>
          Reply
        </Button>
      </div>
      {replying ? (
        <CommentComposer
          storyId={storyId}
          threadId={comment.thread_id}
          parentContributionId={comment.contribution_id}
          onCancel={() => setReplying(false)}
        />
      ) : null}
      {visibleReplies.length > 0 ? (
        <div className="ml-4 flex flex-col gap-3 border-l border-line pl-4">
          {visibleReplies.map((reply) => (
            <CommentItem
              key={reply.contribution_id}
              storyId={storyId}
              comment={reply}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
      {comment.has_more_replies ? (
        <Button
          type="button"
          variant="secondary"
          loading={expandedReplies.isLoading || expandedReplies.isFetching}
          onClick={() => {
            setExpanded(true);
            void expandedReplies.refetch();
          }}
        >
          Load all {comment.reply_count} replies
        </Button>
      ) : null}
    </article>
  );
}

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
      ) : comments.data?.comments.length === 0 ? (
        <p className="rounded-md border border-line p-4 text-sm text-ink-muted">
          No comments yet. Start the conversation with context or a source.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {comments.data?.comments.map((comment) => (
            <CommentItem key={comment.contribution_id} storyId={storyId} comment={comment} />
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
          Load more comments
        </Button>
      ) : null}
    </section>
  );
}
