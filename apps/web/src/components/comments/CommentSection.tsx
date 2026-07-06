// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7 inline story comment section.  Comments render through the sanctioned
// UGC sink and stay strictly no-applause (no likes, votes, counters-as-reactions,
// or popularity affordances).  The section shows up to TWO nested reply layers
// inline (parent → reply → reply-to-reply); a thread that continues deeper — or a
// comment with more direct replies than are shown — links into the dedicated
// comment-centric page (`/stories/$storyId/comments`, re-rooted at that comment)
// via each comment's "Continue this thread" / "Show all replies" link.  More
// TOP-LEVEL comments load in place ("Load more comments") — there is no separate
// "show more" jump that duplicated the per-thread continuation.
import { useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useCommentStream } from '../../lib/comment-stream.js';
import {
  useRoomLensesQuery,
  useStoryCommentsQuery,
  useStoryDebatesQuery,
} from '../../lib/queries.js';
import { raisedInteractive, raisedSurface } from '../../lib/surfaces.js';
import { Button } from '../ui/Button/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { Icon } from '../ui/Icon/index.js';
import { CommentNode } from './CommentNode.js';
import { CommentComposer } from './CommentParts.js';
import { DebatePanel } from './DebatePanel.js';

export interface CommentSectionProps {
  storyId: string;
  threadId: string;
  /** The home room — enables the lens picker + the conversation lens filter. */
  roomId?: string;
}

/** The inline section renders up to two nested reply layers (parent → reply →
 *  reply-to-reply); anything deeper links into the dedicated comment page. */
const INLINE_MAX_DEPTH = 2;

export function CommentSection({
  storyId,
  threadId,
  roomId,
}: CommentSectionProps): React.ReactElement {
  // No type filter tabs: sources are read per-comment via the "Sources" footnote
  // modal, and live corrections/debates surface in the active-debates panel — so
  // a top-level Sources/Corrections filter would be redundant.
  const comments = useStoryCommentsQuery(storyId, { depth: INLINE_MAX_DEPTH });
  const stream = useCommentStream(storyId);
  const debates = useStoryDebatesQuery(storyId);
  const lenses = useRoomLensesQuery(roomId ?? '', roomId !== undefined);
  const [selectedLensId, setSelectedLensId] = useState<string | null>(null);

  const all = comments.data?.comments ?? [];
  // WS-G.2.2 conversation lens filter: read each community's interpretation on
  // its own. Lens ids come from every top-level comment's metadata (already on
  // the wire); names come from the room's lens list. Chips appear only once TWO
  // or more lenses are actually present — that is when filtering by reading has
  // something to distinguish (never a popularity/vote control).
  const lensName = new Map((lenses.data ?? []).map((lens) => [lens.lens_id, lens.name]));
  const lensCounts = new Map<string, number>();
  for (const comment of all) {
    const id = comment.metadata.lens_id;
    if (id !== undefined && lensName.has(id)) lensCounts.set(id, (lensCounts.get(id) ?? 0) + 1);
  }
  const presentLenses = [...lensCounts.keys()];
  const showLensFilter = presentLenses.length >= 2;
  const activeLens =
    selectedLensId !== null && lensCounts.has(selectedLensId) ? selectedLensId : null;
  const visible =
    activeLens !== null ? all.filter((comment) => comment.metadata.lens_id === activeLens) : all;

  return (
    <section id="comments" className="mt-6 flex flex-col gap-4" aria-label="Conversation">
      {debates.data ? <DebatePanel storyId={storyId} debates={debates.data.debates} /> : null}
      <CommentComposer storyId={storyId} threadId={threadId} {...(roomId ? { roomId } : {})} />
      {showLensFilter ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by lens">
          <LensChip
            label={`All (${all.length})`}
            active={activeLens === null}
            onClick={() => setSelectedLensId(null)}
          />
          {presentLenses.map((id) => (
            <LensChip
              key={id}
              label={`${lensName.get(id) ?? 'Lens'} (${lensCounts.get(id) ?? 0})`}
              active={activeLens === id}
              onClick={() => setSelectedLensId(id)}
            />
          ))}
        </div>
      ) : null}
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
      {/* More TOP-LEVEL comments than the first page — appended in place. Deeper
          replies are reached per-thread via each comment's "Continue" link, so
          this never duplicates that continuation. */}
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

/** A single lens filter toggle (WS-G.2.2). Not a vote — it scopes the reading. */
function LensChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        active
          ? 'border-primary bg-primary-soft text-primary-on-soft'
          : 'border-line text-ink-muted hover:bg-surface',
      )}
    >
      {label}
    </button>
  );
}
