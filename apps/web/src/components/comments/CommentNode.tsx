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
import { type CommentItem as CommentItemType, resolveCommentSources } from '@licio/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useRecordReplyDepth } from '../../hooks/useRecordReplyDepth.js';
import { cn } from '../../lib/cn.js';
import { ReportSheet } from '../safety/ReportSheet.js';
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
import { SourcesDialog } from './SourcesDialog.js';

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

export function CommentNode({
  storyId,
  comment,
  depthInView,
  maxDepthInView,
}: CommentNodeProps): React.ReactElement {
  const [replying, setReplying] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [reporting, setReporting] = useState(false);
  const navigate = useNavigate();
  const disputed = comment.dispute_status !== 'none';
  // Sources are the inline links in the body (+ any legacy bare citations); the
  // count drives the compact "Sources (N)" footnote affordance.
  const sourceCount = resolveCommentSources(comment.body, comment.citations).length;

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
      {comment.body.length > 0 ? (
        <div className={disputed ? 'opacity-75' : undefined}>
          <UgcBody markdown={comment.body} compact />
        </div>
      ) : null}
      <CommentMedia comment={comment} />

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
        {/* The sourced statements as a numbered footnote list (modal). */}
        {sourceCount > 0 ? (
          <button
            type="button"
            className={commentActionClass}
            aria-haspopup="dialog"
            aria-expanded={showSources}
            onClick={() => setShowSources(true)}
          >
            <Icon name="quote" className="size-3.5" aria-hidden />
            {sourceCount === 1 ? 'Sources (1)' : `Sources (${sourceCount})`}
          </button>
        ) : null}
        {/* Report this comment (two-tap sheet) — flag is the report affordance. */}
        <button
          type="button"
          className={commentActionClass}
          aria-haspopup="dialog"
          onClick={() => setReporting(true)}
        >
          <Icon name="flag" className="size-3.5" aria-hidden />
          Report
        </button>
        {/* An open arena is challenging this comment: anyone — especially the
            incumbent author returning to post their 12-hour position — reaches it
            here (the `Correct` button is disabled while under debate). */}
        {comment.active_debate_id ? (
          <Link
            to="/stories/$storyId/debate/$debateId"
            params={{ storyId, debateId: comment.active_debate_id }}
            className={commentActionClass}
          >
            <Icon name="chevron-right" className="size-3.5" aria-hidden />
            View debate
          </Link>
        ) : null}
        {!canNestDeeper && replyCount > 0 ? (
          <ContinueThreadLink
            storyId={storyId}
            rootId={comment.contribution_id}
            label={`Continue this thread (${replyCount} ${replyWord})`}
          />
        ) : null}
      </div>

      <SourcesDialog open={showSources} onClose={() => setShowSources(false)} comment={comment} />

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
            void navigate({
              to: '/stories/$storyId/debate/$debateId',
              params: { storyId, debateId },
            });
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
