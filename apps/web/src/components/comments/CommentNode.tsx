// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7.2 recursive comment renderer shared by the inline story-page section
// (`maxDepthInView: 1` — one nested layer, to protect the reading area) and the
// dedicated comment-centric page (`maxDepthInView: 2`).  When a thread continues
// past the view's depth budget, the node renders a "continue this thread" /
// "show all replies" link into the dedicated page re-rooted at that comment,
// instead of nesting further — so depth is unbounded by navigation, never by
// ever-shrinking indentation.
import type { CommentItem as CommentItemType } from '@licio/shared';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { raisedInteractive, raisedSurface } from '../../lib/surfaces.js';
import { getSignalProcessor } from '../../signals/runtime.js';
import { UgcBody } from '../ugc/UgcBody.js';
import { Button } from '../ui/Button/index.js';
import { Icon } from '../ui/Icon/index.js';
import { CommentComposer, CommentHeader, CommentMedia } from './CommentParts.js';

export interface CommentNodeProps {
  storyId: string;
  comment: CommentItemType;
  /** This node's depth WITHIN THE CURRENT VIEW (0 = a listed root/anchor child). */
  depthInView: number;
  /** Nested layers this view renders before deferring to the dedicated page. */
  maxDepthInView: number;
}

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
      className={cn(
        'inline-flex items-center gap-1 self-start px-3 py-2 text-sm font-medium text-primary-on-soft',
        raisedSurface,
        raisedInteractive,
      )}
    >
      {label}
      <Icon name="chevron-right" className="size-4" aria-hidden />
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
  // Record the ABSOLUTE reply depth for attention bucketing (WS-H PHI input) —
  // the in-view depth is presentational only.
  useEffect(() => {
    getSignalProcessor().recordReplyDepth(storyId, comment.depth);
  }, [storyId, comment.depth]);

  const canNestDeeper = depthInView < maxDepthInView;
  const replyCount = comment.reply_count;
  const replyWord = replyCount === 1 ? 'reply' : 'replies';

  return (
    <article className={cn('flex flex-col gap-3 p-4', raisedSurface)}>
      <CommentHeader comment={comment} />
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

      {canNestDeeper && comment.replies.length > 0 ? (
        <div className="ml-3 flex flex-col gap-3 border-l-2 border-line pl-3 sm:ml-4 sm:pl-4">
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

      {/* Past the depth budget OR more direct replies than previewed → defer to
          the dedicated comment-centric page (re-rooted here) so the reading area
          never collapses under runaway indentation. */}
      {canNestDeeper ? (
        comment.has_more_replies ? (
          <ContinueThreadLink
            storyId={storyId}
            rootId={comment.contribution_id}
            label={`Show all ${replyCount} ${replyWord}`}
          />
        ) : null
      ) : replyCount > 0 ? (
        <ContinueThreadLink
          storyId={storyId}
          rootId={comment.contribution_id}
          label={`Continue this thread (${replyCount} ${replyWord})`}
        />
      ) : null}
    </article>
  );
}
