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
import { relativeTimeShort } from '../../lib/time.js';
import { MarkdownEditor } from '../composer/MarkdownEditor/index.js';
import { Button } from '../ui/Button/index.js';

export function authorName(comment: CommentItemType): string {
  return comment.author_display_name ?? comment.author_handle ?? 'Deleted account';
}

/**
 * The shared compact comment-action affordance (Reply, Continue, Show all): a
 * lightweight inline control that still meets the WCAG 2.2 AA 24px target-size
 * minimum (28px tall via the padding) without the chunky touch-height of a full
 * Button.
 */
export const commentActionClass =
  'inline-flex min-h-[1.75rem] items-center gap-1 rounded px-1.5 py-1 text-sm font-medium text-primary-on-soft transition-colors hover:bg-surface hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** A single-line meta row: `Author · 3h` with an optional typed-card tag. The
 *  full localized timestamp is on the `<time>` element's `title`/`dateTime`. */
export function CommentHeader({ comment }: { comment: CommentItemType }): React.ReactElement {
  const tag =
    comment.type === 'evidence' ? 'Source' : comment.type === 'correction' ? 'Correction' : null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm leading-tight">
      <span className="font-medium text-ink">{authorName(comment)}</span>
      <span className="text-ink-muted" aria-hidden>
        ·
      </span>
      <time
        dateTime={comment.created_at}
        title={new Date(comment.created_at).toLocaleString()}
        className="text-ink-muted"
      >
        {relativeTimeShort(comment.created_at)}
      </time>
      {tag ? (
        <span className="rounded border border-line px-1.5 py-px text-xs font-medium uppercase tracking-wide text-ink-muted">
          {tag}
        </span>
      ) : null}
    </div>
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
              'max-h-72 w-full object-contain',
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
  const isReply = parentContributionId !== undefined;
  const fieldId = parentContributionId ? `reply-${parentContributionId}` : 'comment-body';
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {isReply ? (
        // Replies open inline inside a thread and can nest deep, so they stay a
        // plain, short box to keep the reading column dense.
        <>
          <label className="sr-only" htmlFor={fieldId}>
            Write a reply
          </label>
          <textarea
            id={fieldId}
            value={body}
            maxLength={5000}
            onChange={(event) => setBody(event.currentTarget.value)}
            placeholder="Reply with context…"
            className="min-h-20 rounded-md border border-line bg-surface p-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
        </>
      ) : (
        // The single top-level composer gets the rich Markdown editor — comments
        // render Markdown-lite through the sanctioned UgcBody sink, so formatting +
        // Preview here are what the reader will actually see.
        <MarkdownEditor
          id={fieldId}
          label="Write a comment"
          value={body}
          onChange={setBody}
          compact
          maxLength={5000}
          placeholder="Add a comment with context…"
        />
      )}
      <div className={cn('flex items-center gap-3', isReply ? 'justify-between' : 'justify-end')}>
        {isReply ? (
          <p className="text-sm text-ink-muted">{trimmed.length}/5000 characters</p>
        ) : null}
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
            {isReply ? 'Reply' : 'Comment'}
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
