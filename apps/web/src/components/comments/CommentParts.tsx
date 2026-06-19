// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared comment primitives reused by the inline story-page section AND the
// dedicated comment-centric page: the author/timestamp header, the metadata-
// stripped image/GIF media grid, and the write contract composer.  All comment
// text renders through the sanctioned UGC sink and stays strictly no-applause
// (no likes, votes, counters-as-reactions, or popularity affordances).
import type { CommentItem as CommentItemType, ContributionWriteCreate } from '@licio/shared';
import { useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useCreateCommentMutation } from '../../lib/queries.js';
import { Button } from '../ui/Button/index.js';

export function authorName(comment: CommentItemType): string {
  return comment.author_display_name ?? comment.author_handle ?? 'Deleted account';
}

export function CommentHeader({ comment }: { comment: CommentItemType }): React.ReactElement {
  return (
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
  );
}

export function CommentMedia({ comment }: { comment: CommentItemType }): React.ReactElement | null {
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
            src={item.url}
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
                href={item.url}
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

export function CommentComposer({
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
  const fieldId = parentContributionId ? `reply-${parentContributionId}` : 'comment-body';
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor={fieldId}>
        {parentContributionId ? 'Write a reply' : 'Write a comment'}
      </label>
      <textarea
        id={fieldId}
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
