// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7.3 recursive comment renderer shared by the inline story-page section
// and the dedicated comment page.  It renders up to `maxDepthInView` nested reply
// layers — 2 for the inline section and the unrooted page, 1 for a focused
// re-rooted view — and links onward (re-rooted) when a thread continues deeper.
//
// Density: a top-level comment is a COMPACT raised tile (`neu-raised-sm`, an 8px
// halo that is safe at gap-3); its replies render as FLAT left-rail threads — no
// card-in-card chrome — so nesting costs only a hairline rail + a little indent.
// Meta is a single line, and actions are inline text links rather than chunky
// buttons.  When a thread continues past the view's depth budget the node links
// into the dedicated page re-rooted at that comment instead of nesting further.
import {
  type CommentItem as CommentItemType,
  type ContributionDisputeStatus,
  resolveLegacyBareCitations,
} from '@licio/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useRecordReplyDepth } from '../../hooks/useRecordReplyDepth.js';
import { cn } from '../../lib/cn.js';
import { formatSourceUrl } from '../../lib/format-source-url.js';
import { useOpenDebate } from '../debate/open-debate.js';
import { ReportSheet } from '../safety/ReportSheet.js';
import { SafeExternalLink } from '../ugc/SafeExternalLink.js';
import { UgcBody } from '../ugc/UgcBody.js';
import { Dialog } from '../ui/Dialog/index.js';
import { Icon } from '../ui/Icon/index.js';
import {
  CommentComposer,
  CommentHeader,
  CommentMedia,
  CorrectionComposer,
  commentActionClass,
} from './CommentParts.js';

export interface CommentNodeProps {
  storyId: string;
  comment: CommentItemType;
  /** This node's depth WITHIN THE CURRENT VIEW (0 = a listed root/anchor child). */
  depthInView: number;
  /** Nested layers this view renders before deferring to the dedicated page. */
  maxDepthInView: number;
}

/** A top-level comment tile vs. a nested reply's flat thread rail. */
const ROOT_TILE = 'rounded-lg border border-line bg-canvas neu-raised-sm p-3';
const NESTED_RAIL = 'border-l-2 border-line pl-3';

/** "Continue this thread" / "Show all replies" → the dedicated page, re-rooted
 *  at `rootId` (where the reader can read its two further nested layers). */
function ContinueThreadLink({
  storyId,
  rootId,
  label,
}: {
  storyId: string;
  rootId: string;
  label: string;
}): React.ReactElement {
  return (
    <Link
      to="/stories/$storyId/comments"
      params={{ storyId }}
      search={{ root: rootId }}
      className={commentActionClass}
    >
      {label}
      <Icon name="chevron-right" className="size-3.5" aria-hidden />
    </Link>
  );
}

/**
 * A story-target correction challenges the WHOLE story (the thread's parent),
 * not a comment, so it is a ROOT post rather than a nested reply — and it PINS
 * to the top of the section while the challenge is live or has prevailed (the
 * server orders it there).  This callout denotes the story-level challenge and
 * opens the debate in one click:
 *   • a LIVE or PREVAILING challenge reads in the story's warning "Challenged"
 *     dispute tone;
 *   • a challenge the adjudicator RULED AGAINST is marked `incorrect` and sunk
 *     to the bottom, so its callout reads as a settled failure (neutral) — the
 *     header's "Incorrect" badge carries the outcome.
 * Falls back to a non-interactive note when no arena resolved (graceful).
 */
function StoryChallengeCallout({
  excerpt,
  debateId,
  disputeStatus,
  onOpen,
}: {
  excerpt: string | null;
  debateId: string | null;
  disputeStatus: ContributionDisputeStatus;
  onOpen: (debateId: string) => void;
}): React.ReactElement {
  const failed = disputeStatus === 'incorrect';
  const calloutClass = cn(
    'flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-left text-sm',
    failed
      ? 'border-line bg-surface text-ink-muted'
      : 'border-warning/40 bg-warning-soft text-warning-on-soft',
  );
  const body = (
    <>
      <Icon name="flag" className="size-3.5 shrink-0" aria-hidden />
      <span className="font-semibold">
        {failed ? 'This challenge to the story did not hold' : 'Challenges this story'}
      </span>
      {!failed && excerpt !== null ? <span className="opacity-90">— “{excerpt}”</span> : null}
      {debateId !== null ? (
        <span className="ml-auto inline-flex items-center gap-1 font-medium">
          View debate
          <Icon name="chevron-right" className="size-3.5" aria-hidden />
        </span>
      ) : null}
    </>
  );
  if (debateId === null) {
    return (
      <div role="note" className={calloutClass}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => onOpen(debateId)}
      className={cn(
        calloutClass,
        'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        failed ? 'hover:border-line-strong' : 'hover:border-warning/70',
      )}
    >
      {body}
    </button>
  );
}

export function CommentNode({
  storyId,
  comment,
  depthInView,
  maxDepthInView,
}: CommentNodeProps): React.ReactElement {
  const [replying, setReplying] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [reporting, setReporting] = useState(false);
  const openDebate = useOpenDebate();
  // "Disputed" for dimming + blocking a new correction means an ACTIVE debate or
  // a settled-incorrect outcome. A `validated` comment (challenged and proven
  // accurate) is neither dimmed nor blocked — it stays re-challengeable on new
  // evidence, matching the server guard (which rejects only under_debate/incorrect).
  const disputed =
    comment.dispute_status === 'under_debate' || comment.dispute_status === 'incorrect';
  // Sources render INLINE as clickable links in the body itself (WS-T; the
  // `.ugc-body a` affordance). Only legacy "bare" citations — old comments whose
  // stored citations have no matching inline body link — need a trailing
  // fallback list so no source is ever dropped when the modal is gone.
  const legacySources = resolveLegacyBareCitations(comment.body, comment.citations);

  // Record the ABSOLUTE reply depth for §5.3 traversal bucketing only once the
  // comment is actually SEEN (visibility-gated; see the hook). The in-view depth
  // is presentational only.
  const recordDepthWhenVisible = useRecordReplyDepth(storyId, comment.depth);

  const canNestDeeper = depthInView < maxDepthInView;
  const replyCount = comment.reply_count;
  const replyWord = replyCount === 1 ? 'reply' : 'replies';

  return (
    <article
      ref={recordDepthWhenVisible}
      className={cn('flex flex-col gap-2', depthInView === 0 ? ROOT_TILE : NESTED_RAIL)}
    >
      <CommentHeader comment={comment} />
      {/* WS-T — a correction always denotes WHAT it challenges and links to its
          debate arena (live or resolved), so it is never a floating claim:
          • a COMMENT-target correction threads directly UNDER the comment it
            corrects (server-derived parent), so its placement IS the denotation;
            a muted line adds the debate link.
          • a STORY-target correction challenges the whole story (the thread's
            parent) and is a ROOT post, so it carries a prominent, warning-toned
            callout that opens the debate in one click. */}
      {comment.type === 'correction' ? (
        comment.metadata.target_story_id ? (
          <StoryChallengeCallout
            excerpt={comment.metadata.target_text_excerpt ?? null}
            debateId={comment.metadata.debate_arena_id ?? null}
            disputeStatus={comment.dispute_status}
            onOpen={openDebate}
          />
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-ink-muted">
            <Icon name="pencil" className="size-3.5 shrink-0" aria-hidden />
            <span>Correcting the comment above</span>
            {comment.metadata.debate_arena_id ? (
              <button
                type="button"
                aria-haspopup="dialog"
                className={commentActionClass}
                onClick={() => {
                  const arenaId = comment.metadata.debate_arena_id;
                  if (arenaId) openDebate(arenaId);
                }}
              >
                <Icon name="chevron-right" className="size-3.5" aria-hidden />
                View debate
              </button>
            ) : null}
          </p>
        )
      ) : null}
      {comment.body.length > 0 ? (
        <div className={disputed ? 'opacity-75' : undefined}>
          <UgcBody markdown={comment.body} compact />
        </div>
      ) : null}
      <CommentMedia comment={comment} />

      {/* Legacy bare citations only: sources with no inline body link (old
          comments). New comments carry every source inline as a styled link in
          the body above, so this is empty for them. */}
      {legacySources.length > 0 ? (
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-ink-muted">
          <span className="font-medium">Sources:</span>
          {legacySources.map((source) => (
            <SafeExternalLink
              key={source.url}
              href={source.url}
              className="break-words text-primary-on-soft hover:underline"
            >
              {source.statement === source.url
                ? // Shorten a raw-URL statement to its host for readability, but
                  // fall back to the full URL when there is no host (e.g. a
                  // `doi:10…` citation is an opaque URI) so the link never renders
                  // empty and the source can't disappear.
                  formatSourceUrl(source.url).host || source.url
                : source.statement}
            </SafeExternalLink>
          ))}
        </p>
      ) : null}

      {/* Compact action row. A leaf (past the view's depth budget) carries its
          "continue" inline here; a materialized node's "show all" sits after the
          replies it already shows (below), reading as "there is more under this". */}
      <div className="-ml-1.5 flex flex-wrap items-center gap-x-1 gap-y-0.5">
        <button
          type="button"
          className={commentActionClass}
          aria-expanded={replying}
          onClick={() => setReplying((value) => !value)}
        >
          Reply
        </button>
        {/* Raise a sourced correction → opens the debate arena (in a modal).
            Disabled while an arena is already open or the comment was already
            found incorrect. Pencil icon (never the flag — flag means report). */}
        {comment.type !== 'correction' ? (
          <button
            type="button"
            className={cn(commentActionClass, disputed && 'cursor-not-allowed opacity-50')}
            aria-haspopup="dialog"
            aria-expanded={correcting}
            disabled={disputed}
            title={disputed ? 'This comment already has a debate outcome.' : undefined}
            onClick={() => setCorrecting(true)}
          >
            <Icon name="pencil" className="size-3.5" aria-hidden />
            Correct
          </button>
        ) : null}
        {/* Report this comment (two-tap sheet). Icon-only flag — mirrors the
            story card's report control (StoryFeedLink) — to keep the action row
            compact; the accessible name carries the full intent. */}
        <button
          type="button"
          className={commentActionClass}
          aria-haspopup="dialog"
          aria-label="Report this comment"
          title="Report this comment"
          onClick={() => setReporting(true)}
        >
          <Icon name="flag" className="size-4" aria-hidden />
        </button>
        {/* An open arena is challenging this comment: anyone — especially the
            incumbent author returning to adjust their content and post their
            rebuttal — opens the arena MODAL here (the `Correct` button is
            disabled while under debate). */}
        {comment.active_debate_id ? (
          <button
            type="button"
            aria-haspopup="dialog"
            className={commentActionClass}
            onClick={() => comment.active_debate_id && openDebate(comment.active_debate_id)}
          >
            <Icon name="chevron-right" className="size-3.5" aria-hidden />
            View debate
          </button>
        ) : null}
        {!canNestDeeper && replyCount > 0 ? (
          <ContinueThreadLink
            storyId={storyId}
            rootId={comment.contribution_id}
            label={`Continue this thread (${replyCount} ${replyWord})`}
          />
        ) : null}
      </div>

      {reporting ? (
        <ReportSheet
          open
          onClose={() => setReporting(false)}
          targetType="content"
          targetId={comment.contribution_id}
          contentKind="contribution"
        />
      ) : null}

      <Dialog open={correcting} onClose={() => setCorrecting(false)} title="Raise a correction">
        <CorrectionComposer
          storyId={storyId}
          threadId={comment.thread_id}
          target={{ commentId: comment.contribution_id }}
          onCancel={() => setCorrecting(false)}
          onOpened={(debateId) => {
            setCorrecting(false);
            openDebate(debateId);
          }}
        />
      </Dialog>

      {replying ? (
        <CommentComposer
          storyId={storyId}
          threadId={comment.thread_id}
          parentContributionId={comment.contribution_id}
          onCancel={() => setReplying(false)}
        />
      ) : null}

      {canNestDeeper && comment.replies.length > 0 ? (
        <div className="mt-0.5 flex flex-col gap-2">
          {comment.replies.map((reply) => (
            <CommentNode
              key={reply.contribution_id}
              storyId={storyId}
              comment={reply}
              depthInView={depthInView + 1}
              maxDepthInView={maxDepthInView}
            />
          ))}
        </div>
      ) : null}

      {/* More direct replies than are shown here → the dedicated page (re-rooted),
          gated on the visible count so it never reads "Show all 0 replies". */}
      {canNestDeeper && replyCount > comment.replies.length ? (
        <div className="-ml-1.5">
          <ContinueThreadLink
            storyId={storyId}
            rootId={comment.contribution_id}
            label={`Show all ${replyCount} ${replyWord}`}
          />
        </div>
      ) : null}
    </article>
  );
}
