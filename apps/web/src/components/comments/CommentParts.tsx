// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared comment primitives reused by the inline story-page section AND the
// dedicated comment-centric page: the author/timestamp header, the metadata-
// stripped image/GIF media grid, and the write contract composer.  All comment
// text renders through the sanctioned UGC sink and stays strictly no-applause
// (no likes, votes, counters-as-reactions, or popularity affordances).
import {
  type Citation,
  type CommentItem as CommentItemType,
  type ContributionWriteCreate,
  citationUrlSchema,
} from '@licio/shared';
import { useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useCreateCommentMutation } from '../../lib/queries.js';
import { raisedSurface } from '../../lib/surfaces.js';
import { relativeTimeShort } from '../../lib/time.js';
import { MarkdownEditor } from '../composer/MarkdownEditor/index.js';
import { SafeExternalLink } from '../ugc/SafeExternalLink.js';
import { Button } from '../ui/Button/index.js';
import { Icon } from '../ui/Icon/index.js';

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

const badgeBase =
  'rounded border px-1.5 py-px text-xs font-medium uppercase tracking-wide leading-tight';

/** A single-line meta row: `Author · 3h` with typed-card / sourced / dispute
 *  tags.  The full localized timestamp is on the `<time>`'s `title`/`dateTime`. */
export function CommentHeader({ comment }: { comment: CommentItemType }): React.ReactElement {
  const typeTag =
    comment.type === 'evidence' ? 'Source' : comment.type === 'correction' ? 'Correction' : null;
  // A plain comment carrying a source link is "sourced" — greater participation
  // (never applause; the badge marks the presence of evidence, not popularity).
  const sourced = comment.type === 'comment' && comment.citations.length > 0;
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
      {typeTag ? (
        <span className={cn(badgeBase, 'border-line text-ink-muted')}>{typeTag}</span>
      ) : null}
      {sourced ? (
        <span className={cn(badgeBase, 'border-primary/40 text-primary-on-soft')}>Sourced</span>
      ) : null}
      {comment.dispute_status === 'under_debate' ? (
        <span className={cn(badgeBase, 'border-warning/50 text-warning')}>Under debate</span>
      ) : null}
      {comment.dispute_status === 'incorrect' ? (
        <span className={cn(badgeBase, 'border-error/60 text-error')}>Incorrect</span>
      ) : null}
    </div>
  );
}

/** The source links attached to a comment (WS-T sourced comments).  Renders each
 *  citation as a safe external link; empty for an unsourced comment. */
export function CommentSources({
  comment,
}: {
  comment: CommentItemType;
}): React.ReactElement | null {
  if (comment.citations.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" aria-label="Attached sources">
      {comment.citations.map((citation) => (
        <li key={citation.url} className="flex items-start gap-1.5 text-sm">
          <Icon name="quote" className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden />
          <SafeExternalLink
            href={citation.url}
            className="break-all font-medium text-primary-on-soft underline hover:no-underline"
          >
            {citation.title ?? citation.url}
          </SafeExternalLink>
        </li>
      ))}
    </ul>
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
  const [sources, setSources] = useState<string[]>([]);
  const [sourceDraft, setSourceDraft] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  const mutation = useCreateCommentMutation(storyId);
  const trimmed = body.trim();

  const addSource = (): void => {
    const url = sourceDraft.trim();
    if (url.length === 0) return;
    const parsed = citationUrlSchema.safeParse(url);
    if (!parsed.success) {
      setSourceError('Enter a valid http(s) or doi: link.');
      return;
    }
    if (!sources.includes(url)) setSources((prev) => [...prev, url]);
    setSourceDraft('');
    setSourceError(null);
  };

  const submit = (): void => {
    if (trimmed.length === 0 || mutation.isPending) return;
    const citations: Citation[] = sources.map((url) => ({ url }));
    const payload: ContributionWriteCreate = {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: crypto.randomUUID(),
      body: trimmed,
      ...(citations.length > 0 ? { citations } : {}),
      ...(parentContributionId ? { parent_contribution_id: parentContributionId } : {}),
    };
    mutation.mutate(payload, {
      onSuccess: () => {
        setBody('');
        setSources([]);
        setSourceDraft('');
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
      {/* Attach source links — a sourced comment counts as greater participation. */}
      <div className="flex flex-col gap-1.5">
        {sources.length > 0 ? (
          <ul className="flex flex-col gap-1" aria-label="Attached sources">
            {sources.map((url) => (
              <li key={url} className="flex items-center gap-1.5 text-sm">
                <Icon name="quote" className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
                <span className="min-w-0 flex-1 break-all text-ink-muted">{url}</span>
                <button
                  type="button"
                  onClick={() => setSources((prev) => prev.filter((s) => s !== url))}
                  className="shrink-0 rounded px-1 text-sm text-ink-muted hover:text-error focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  aria-label={`Remove source ${url}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="sr-only">Add a source link</span>
            <input
              type="url"
              inputMode="url"
              value={sourceDraft}
              onChange={(event) => {
                setSourceDraft(event.currentTarget.value);
                if (sourceError) setSourceError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addSource();
                }
              }}
              placeholder="Add a source link (optional)"
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            onClick={addSource}
            disabled={sourceDraft.trim().length === 0}
          >
            <Icon name="quote" className="size-4" />
            Add source
          </Button>
        </div>
        {sourceError ? (
          <p role="alert" className="text-sm text-error">
            {sourceError}
          </p>
        ) : null}
      </div>
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

/**
 * Raise a sourced CORRECTION against a comment or story (WS-T).  A correction
 * MUST carry at least one source and opens a live debate arena; the incumbent
 * (the target's author) and this challenger then argue it out.  On success the
 * arena id is on the created contribution's metadata — the caller navigates to
 * the arena.
 */
export function CorrectionComposer({
  storyId,
  threadId,
  target,
  onOpened,
  onCancel,
}: {
  storyId: string;
  threadId: string;
  /** Exactly one of a comment target or the story root. */
  target: { commentId: string } | { storyRoot: true };
  onOpened: (debateId: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [body, setBody] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [sourceDraft, setSourceDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useCreateCommentMutation(storyId);
  const trimmed = body.trim();

  const addSource = (): void => {
    const url = sourceDraft.trim();
    if (url.length === 0) return;
    if (!citationUrlSchema.safeParse(url).success) {
      setError('Enter a valid http(s) or doi: link.');
      return;
    }
    if (!sources.includes(url)) setSources((prev) => [...prev, url]);
    setSourceDraft('');
    setError(null);
  };

  const submit = (): void => {
    if (trimmed.length === 0 || mutation.isPending) return;
    if (sources.length === 0) {
      setError('A correction must cite at least one source.');
      return;
    }
    const citations = sources.slice(0, 5).map((url) => ({ url })) as [Citation, ...Citation[]];
    const payload: ContributionWriteCreate = {
      type: 'correction',
      thread_id: threadId,
      client_draft_id: crypto.randomUUID(),
      body: trimmed,
      citations,
      ...('commentId' in target
        ? { target_contribution_id: target.commentId }
        : { target_story_id: storyId }),
    };
    mutation.mutate(payload, {
      onSuccess: (response) => {
        const debateId = response.contribution.metadata.debate_arena_id;
        if (debateId) onOpened(debateId);
        else onCancel();
      },
    });
  };

  return (
    <form
      className={cn('flex flex-col gap-2 p-3', raisedSurface)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      aria-label="Raise a correction"
    >
      <p className="text-sm text-ink-muted">
        A correction is a <strong className="text-ink">sourced</strong> challenge. It opens an open
        debate the room's AI judges — you and the author each make your case for 12 hours.
      </p>
      <MarkdownEditor
        id="correction-body"
        label="Your correction"
        value={body}
        onChange={setBody}
        compact
        maxLength={2000}
        placeholder="Explain what is incorrect and why…"
      />
      {sources.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Correction sources">
          {sources.map((url) => (
            <li key={url} className="flex items-center gap-1.5 text-sm">
              <Icon name="quote" className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
              <span className="min-w-0 flex-1 break-all text-ink-muted">{url}</span>
              <button
                type="button"
                onClick={() => setSources((prev) => prev.filter((s) => s !== url))}
                className="shrink-0 rounded px-1 text-sm text-ink-muted hover:text-error focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                aria-label={`Remove source ${url}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="sr-only">Add a supporting source (required)</span>
          <input
            type="url"
            inputMode="url"
            value={sourceDraft}
            onChange={(event) => {
              setSourceDraft(event.currentTarget.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addSource();
              }
            }}
            placeholder="Add a supporting source (required)"
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          onClick={addSource}
          disabled={sourceDraft.trim().length === 0}
        >
          Add source
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={mutation.isPending}
          disabled={trimmed.length === 0 || sources.length === 0}
        >
          Open debate
        </Button>
      </div>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-error">
          The correction could not be opened. Please try again.
        </p>
      ) : null}
    </form>
  );
}
