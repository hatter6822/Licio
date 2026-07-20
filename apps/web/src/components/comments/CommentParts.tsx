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
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZodError } from 'zod';
import { ApiClientError } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { useCreateCommentMutation } from '../../lib/queries.js';
import { relativeTimeShort } from '../../lib/time.js';
import {
  type DraftContributionRecord,
  deleteDraft,
  listDraftsForThread,
  queue,
  saveDraft,
} from '../../offline/index.js';
import { MarkdownEditor } from '../composer/MarkdownEditor/index.js';
import { DisputeBadge } from '../story/DisputeBadge/index.js';
import { Button } from '../ui/Button/index.js';

/** Trailing autosave debounce: one encrypt+write per pause (mirrors StoryComposer). */
const DRAFT_DEBOUNCE_MS = 800;

/**
 * A failed post is TRANSIENT when a later retry could succeed — offline/network,
 * a 5xx, or a 408/429.  A 4xx validation / locked-thread reject (or a corrupt
 * payload / invalid_response) is TERMINAL and must NOT be queued.  This mirrors
 * `isTerminal` in `offline/sync.ts`, which classifies the same way when the queue
 * later replays the operation, so a queued write is one the drain will actually
 * accept rather than immediately park as failed.
 */
function isTransientPostFailure(error: unknown): boolean {
  if (error instanceof ZodError) return false;
  if (error instanceof ApiClientError) {
    if (error.code === 'invalid_response') return false;
    if (error.status === 408 || error.status === 429) return true;
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return false;
  }
  // Network error / offline / 5xx / unknown — a retry may succeed.
  return true;
}

interface ContributionDraft {
  /** Stable for the composition lifetime: the payload `client_draft_id`, the draft
   *  key, AND the offline-queue operationId — so autosave, server idempotency, and
   *  retry all dedupe against ONE id. */
  draftId: string;
  /** The newest resumable saved draft for this thread (recovery prompt input). */
  recoverable: DraftContributionRecord | null;
  resumeRecoverable: () => void;
  discardRecoverable: () => void;
  /** Flush the pending debounced draft immediately (form blur). */
  flush: () => void;
  /** Delete the autosaved draft after a confirmed post (cancels pending writes). */
  clearDraft: () => void;
  /** Queue a transient-failed post for background retry; returns true if queued. */
  queueIfTransient: (payload: ContributionWriteCreate, error: unknown) => boolean;
}

/**
 * Draft autosave + offline queue for a comment/correction composer (mirrors
 * StoryComposer's WS-Q.5.1b wiring): a comment typed offline, or lost to a
 * reload, is preserved rather than silently dropped.  All IndexedDB writes are
 * best-effort (`.catch(() => undefined)`) so a failed persistence never blocks
 * posting (availability > confidentiality, per `offline/drafts.ts`).
 */
function useContributionDraft(args: {
  storyId: string;
  threadId: string;
  contributionType: DraftContributionRecord['contributionType'];
  body: string;
  /** Repopulate the composer when the user resumes a recovered draft. */
  onRecover: (body: string) => void;
  /** Reply boxes autosave + queue but skip the resume prompt (many share a thread). */
  enableRecovery: boolean;
}): ContributionDraft {
  const { storyId, threadId, contributionType, body, onRecover, enableRecovery } = args;
  const draftId = useRef<string>(crypto.randomUUID());
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestBody = useRef(body);
  latestBody.current = body;
  const [recoverable, setRecoverable] = useState<DraftContributionRecord | null>(null);

  const persist = useCallback((): void => {
    const text = latestBody.current.trim();
    if (text.length === 0) return;
    void saveDraft({
      draftId: draftId.current,
      storyId,
      threadId,
      contributionType,
      values: { body: latestBody.current },
    }).catch(() => undefined);
  }, [storyId, threadId, contributionType]);

  // Recovery: on mount surface the newest NON-EMPTY saved draft for this thread
  // that isn't the one being composed now, so a comment lost to a reload can be
  // resumed. Draft I/O is best-effort — a missing/quota-blocked IndexedDB never
  // breaks composing.
  useEffect(() => {
    if (!enableRecovery) return;
    let cancelled = false;
    void listDraftsForThread(threadId)
      .then((drafts) => {
        if (cancelled) return;
        const prior = drafts.find(
          (draft) =>
            draft.draftId !== draftId.current &&
            draft.contributionType === contributionType &&
            (draft.values['body']?.trim().length ?? 0) > 0,
        );
        setRecoverable(prior ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enableRecovery, threadId, contributionType]);

  // Trailing-debounced autosave: an empty composer never writes; each pause
  // persists the latest (AES-GCM-encrypted) body.
  useEffect(() => {
    if (body.trim().length === 0) return;
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      persist();
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [body, persist]);

  const flush = useCallback((): void => {
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    persist();
  }, [persist]);

  // Flush immediately on app backgrounding and on unmount, so a half-written
  // comment is never lost between debounce ticks.
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [flush]);

  const resumeRecoverable = useCallback((): void => {
    setRecoverable((current) => {
      if (current) {
        draftId.current = current.draftId;
        onRecover(current.values['body'] ?? '');
      }
      return null;
    });
  }, [onRecover]);

  const discardRecoverable = useCallback((): void => {
    setRecoverable((current) => {
      if (current) void deleteDraft(current.draftId).catch(() => undefined);
      return null;
    });
  }, []);

  const clearDraft = useCallback((): void => {
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    latestBody.current = '';
    void deleteDraft(draftId.current).catch(() => undefined);
  }, []);

  const queueIfTransient = useCallback(
    (payload: ContributionWriteCreate, error: unknown): boolean => {
      if (!isTransientPostFailure(error)) return false;
      // The operationId is the client_draft_id, so a re-send the server already
      // received is deduped; the queue drain (offline/sync.ts) replays it. The
      // queue now OWNS this write (its SSOT for unsynced writes), so drop the
      // autosaved draft — otherwise a manual resume could post it a second time.
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      latestBody.current = '';
      void queue
        .enqueue('contribution', payload, draftId.current)
        .catch(() => undefined)
        .finally(() => {
          void deleteDraft(draftId.current).catch(() => undefined);
        });
      return true;
    },
    [],
  );

  return {
    draftId: draftId.current,
    recoverable,
    resumeRecoverable,
    discardRecoverable,
    flush,
    clearDraft,
    queueIfTransient,
  };
}

/** The shared resume-or-discard prompt for a recovered comment/correction draft. */
function DraftRecoveryPrompt({
  label,
  onResume,
  onDiscard,
}: {
  label: string;
  onResume: () => void;
  onDiscard: () => void;
}): React.ReactElement {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-sunken p-3"
    >
      <span className="text-ink text-sm">{label}</span>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onResume}>
          Resume
        </Button>
        <Button type="button" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );
}

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
  const typeTag = comment.type === 'correction' ? 'Correction' : null;
  // A plain comment carrying a source link is "sourced" — greater participation
  // (never applause; the badge marks the presence of sources, not popularity).
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
      {/* WS-T dispute posture: "Challenged" while a correction's debate is live,
          "Incorrect" once a correction prevailed (nothing when undisputed). */}
      <DisputeBadge status={comment.dispute_status} />
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
  postingLens,
  leadingAction,
  parentContributionId,
  onCancel,
}: {
  storyId: string;
  threadId: string;
  /** The member's chosen POSTING lens for the home room (WS-G.2.2), passed only
   *  to the TOP-LEVEL composer. A top-level comment written here JOINS this lens
   *  (`id: null` = "Undecided" — no tag); the server re-validates it against the
   *  room's lenses. This is the member's DELIBERATE membership lens — chosen at
   *  join and changed ONLY via the room page's lens button — NOT the "view"
   *  selector's reading/filter lens, so a member never accidentally posts as a
   *  lens they were only viewing. Shown here purely for transparency. Replies
   *  stay untagged. */
  postingLens?: { id: string | null; name: string };
  /** Node rendered on the LEFT of the action row, opposing the Comment button —
   *  the conversation "view" (sort + reading-filter) selector (top-level only). */
  leadingAction?: ReactNode;
  parentContributionId?: string;
  onCancel?: () => void;
}): React.ReactElement {
  const [body, setBody] = useState('');
  const [queued, setQueued] = useState(false);
  const mutation = useCreateCommentMutation(storyId);
  const trimmed = body.trim();
  // Sources are the INLINE links in the body — derived, not a separate list.
  const derivedSources = useMemo(() => deriveCitationsFromBody(trimmed), [trimmed]);
  const isReply = parentContributionId !== undefined;
  // A top-level comment joins the member's POSTING lens (null = Undecided ⇒ no
  // tag); replies stay untagged.
  const postingLensId = isReply ? null : (postingLens?.id ?? null);

  // Draft autosave + offline queue (WS-C.2.2/2.3): a comment typed offline or
  // lost to a reload survives. Reply boxes autosave + queue but skip the resume
  // prompt (many replies share one thread).
  const draft = useContributionDraft({
    storyId,
    threadId,
    contributionType: 'comment',
    body,
    onRecover: setBody,
    enableRecovery: !isReply,
  });

  const submit = (): void => {
    if (trimmed.length === 0 || mutation.isPending) return;
    setQueued(false);
    const citations = derivedSources;
    const payload: ContributionWriteCreate = {
      type: 'comment',
      thread_id: threadId,
      client_draft_id: draft.draftId,
      body: trimmed,
      ...(citations.length > 0 ? { citations } : {}),
      ...(parentContributionId ? { parent_contribution_id: parentContributionId } : {}),
      ...(postingLensId ? { lens_id: postingLensId } : {}),
    };
    mutation.mutate(payload, {
      onSuccess: () => {
        draft.clearDraft();
        setBody('');
        onCancel?.();
      },
      onError: (error) => {
        // Offline / transient failure — the write is queued and replays when
        // connectivity returns; a terminal 4xx keeps the plain error text.
        if (draft.queueIfTransient(payload, error)) setQueued(true);
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
      onBlur={draft.flush}
    >
      {draft.recoverable !== null ? (
        <DraftRecoveryPrompt
          label="You have an unsent comment draft. Resume or discard?"
          onResume={draft.resumeRecoverable}
          onDiscard={draft.discardRecoverable}
        />
      ) : null}
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
      {!isReply && postingLens ? (
        // WS-G.2.2 — transparency only: the lens this comment will post as is the
        // member's chosen membership lens, changed on the room page (never here).
        <p className="text-ink-muted text-xs">
          Posting as <strong className="font-medium text-ink">{postingLens.name}</strong>. Change
          your lens on the room page.
        </p>
      ) : null}
      <div
        className={cn(
          'flex flex-wrap items-center gap-3',
          isReply || leadingAction ? 'justify-between' : 'justify-end',
        )}
      >
        {isReply ? (
          <p className="text-sm text-ink-muted">{trimmed.length}/5000 characters</p>
        ) : (
          // The conversation "view" (sort + reading-filter) selector sits on the
          // LEFT, opposing the Comment button on the right (WS-G.2.2/WS-T). It only
          // affects what you READ; the lens this comment posts as is shown in the
          // "Posting as …" note above and is set on the room page.
          (leadingAction ?? null)
        )}
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
      {queued ? (
        <p role="status" className="text-sm text-ink-muted">
          Saved — this comment will post when you’re back online.
        </p>
      ) : mutation.isError ? (
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
  const [queued, setQueued] = useState(false);
  const mutation = useCreateCommentMutation(storyId);
  const trimmed = body.trim();
  // A correction MUST carry ≥1 source — the sources are the inline links in the
  // correction text (a correction takes at most five).
  const derivedSources = useMemo(() => deriveCitationsFromBody(trimmed).slice(0, 5), [trimmed]);
  const hasSource = derivedSources.length > 0;

  // Draft autosave + offline queue (WS-C.2.2/2.3): a correction typed offline or
  // lost to a reload survives rather than being silently dropped.
  const draft = useContributionDraft({
    storyId,
    threadId,
    contributionType: 'correction',
    body,
    onRecover: setBody,
    enableRecovery: true,
  });

  const submit = (): void => {
    if (trimmed.length === 0 || mutation.isPending) return;
    if (!hasSource) {
      setError('A correction must cite at least one source — link the key phrase to its evidence.');
      return;
    }
    setQueued(false);
    const citations = derivedSources as [Citation, ...Citation[]];
    const payload: ContributionWriteCreate = {
      type: 'correction',
      thread_id: threadId,
      client_draft_id: draft.draftId,
      body: trimmed,
      citations,
      ...('commentId' in target
        ? { target_contribution_id: target.commentId }
        : { target_story_id: storyId }),
    };
    mutation.mutate(payload, {
      onSuccess: (response) => {
        draft.clearDraft();
        const debateId = response.contribution.metadata.debate_arena_id;
        if (debateId) {
          onOpened(debateId);
          return;
        }
        // The correction posted but no arena opened (held for review, or a
        // concurrent challenge won the one-arena-per-target slot).  Say so
        // instead of silently closing the composer.
        setError(
          'Your correction was posted, but no debate opened — it may be held for review, or another challenge is already live for this target.',
        );
      },
      onError: (mutationError) => {
        // Offline / transient failure — queue the correction to replay when
        // connectivity returns; a terminal 4xx keeps the plain error text.
        if (draft.queueIfTransient(payload, mutationError)) setQueued(true);
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
      onBlur={draft.flush}
      aria-label="Raise a correction"
    >
      {draft.recoverable !== null ? (
        <DraftRecoveryPrompt
          label="You have an unsent correction draft. Resume or discard?"
          onResume={draft.resumeRecoverable}
          onDiscard={draft.discardRecoverable}
        />
      ) : null}
      <p className="text-sm text-ink-muted">
        A correction is a <strong className="text-ink">sourced</strong> challenge. It opens a live
        debate the room's AI resolves — you and the author can each adjust your case for up to 24
        hours, and the debate queues for resolution an hour after you both stop editing.
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
      {queued ? (
        <p role="status" className="text-sm text-ink-muted">
          Saved — this correction will open its debate when you’re back online.
        </p>
      ) : mutation.isError ? (
        <p role="alert" className="text-sm text-error">
          The correction could not be opened. Please try again.
        </p>
      ) : null}
    </form>
  );
}
