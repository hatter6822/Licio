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
  deriveCitationsFromBody,
} from '@licio/shared';
import { useMemo, useState } from 'react';
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
  activeLens,
  parentContributionId,
  onCancel,
}: {
  storyId: string;
  threadId: string;
  /** The interpretation lens the conversation is currently scoped to (WS-G.2.2),
   *  passed only to the TOP-LEVEL composer. A comment written here JOINS that
   *  reading — the server re-validates the tag against the room's lenses. There
   *  is ONE lens control (the "view" button + modal above the conversation); the
   *  composer has no separate picker. Replies stay untagged. */
  activeLens?: { id: string; name: string };
  parentContributionId?: string;
  onCancel?: () => void;
}): React.ReactElement {
  const [body, setBody] = useState('');
  const mutation = useCreateCommentMutation(storyId);
  const trimmed = body.trim();
  // Sources are the INLINE links in the body — derived, not a separate list.
  const derivedSources = useMemo(() => deriveCitationsFromBody(trimmed), [trimmed]);
  const isReply = parentContributionId !== undefined;
  // A top-level comment joins the currently-selected lens; replies stay untagged.
  const lensTag = isReply ? undefined : activeLens;

  const submit = (): void => {
    if (trimmed.length === 0 || mutation.isPending) return;
    const citations = derivedSources;
    const payload: ContributionWriteCreate = {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: crypto.randomUUID(),
      body: trimmed,
      ...(citations.length > 0 ? { citations } : {}),
      ...(parentContributionId ? { parent_contribution_id: parentContributionId } : {}),
      ...(lensTag ? { lens_id: lensTag.id } : {}),
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
          enableSourceLink
          helperText="Select a phrase and choose “Add source” to link it to its evidence — a sourced comment carries more participation weight."
        />
      )}
      {derivedSources.length > 0 ? (
        <p className="text-sm text-ink-muted">
          {derivedSources.length === 1
            ? '1 source linked in this comment.'
            : `${derivedSources.length} sources linked in this comment.`}
        </p>
      ) : null}
      <div
        className={cn(
          'flex flex-wrap items-center gap-3',
          isReply || lensTag ? 'justify-between' : 'justify-end',
        )}
      >
        {isReply ? (
          <p className="text-sm text-ink-muted">{trimmed.length}/5000 characters</p>
        ) : lensTag ? (
          // The conversation is scoped to a lens (via the view control above), so
          // this comment JOINS that reading — a quiet hint on the LEFT of the
          // action row (the Comment button stays on the right). Not a vote;
          // switch/clear the lens with the view control.
          <p className="text-sm text-ink-muted">
            Posting to the <span className="font-medium text-ink">{lensTag.name}</span> lens
          </p>
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
  const [error, setError] = useState<string | null>(null);
  const mutation = useCreateCommentMutation(storyId);
  const trimmed = body.trim();
  // A correction MUST carry ≥1 source — the sources are the inline links in the
  // correction text (a correction takes at most five).
  const derivedSources = useMemo(() => deriveCitationsFromBody(trimmed).slice(0, 5), [trimmed]);
  const hasSource = derivedSources.length > 0;

  const submit = (): void => {
    if (trimmed.length === 0 || mutation.isPending) return;
    if (!hasSource) {
      setError('A correction must cite at least one source — link the key phrase to its evidence.');
      return;
    }
    const citations = derivedSources as [Citation, ...Citation[]];
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
      className="flex flex-col gap-3"
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
        enableSourceLink
        helperText="Select the key phrase and choose “Add source” to link it to its evidence — a correction requires at least one source."
      />
      <p className="text-sm text-ink-muted">
        {hasSource
          ? derivedSources.length === 1
            ? '1 source linked.'
            : `${derivedSources.length} sources linked.`
          : 'No source linked yet — turn the key phrase into a link to its source.'}
      </p>
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
          disabled={trimmed.length === 0 || !hasSource}
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
