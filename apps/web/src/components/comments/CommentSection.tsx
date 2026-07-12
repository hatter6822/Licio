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
import { useCommentStream } from '../../lib/comment-stream.js';
import {
  useRoomQuery,
  useStoryCommentsQuery,
  useStoryDebatesQuery,
  useStoryInterpretationsQuery,
} from '../../lib/queries.js';
import { lensDisplayName } from '../rooms/RoomLensControl/RoomLensSelector.js';
import { WhereInterpretationsDiffer } from '../story/WhereInterpretationsDiffer/index.js';
import { Button } from '../ui/Button/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { Icon } from '../ui/Icon/index.js';
import { Sheet } from '../ui/Sheet/index.js';
import { CommentNode } from './CommentNode.js';
import { CommentComposer } from './CommentParts.js';
import {
  type CommentViewMode,
  CommentViewSelector,
  lensIdOfView,
  viewLabel,
} from './CommentViewSelector.js';
import { byParticipationDesc } from './comment-participation.js';
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
  // ONE comment "view" control (WS-G.2.2 / WS-T): a button → modal Sheet that
  // both SORTS (newest/oldest/highest-participation) and FILTERS by lens. It is a
  // READING control only — the lens you post as is your membership lens (chosen at
  // join / via the room's lens button), never this filter. `newest`/`oldest` are
  // server-ordered across the whole thread; the participation sort and lens filter
  // are client-side over the loaded top page (this section is a preview).
  const [view, setView] = useState<CommentViewMode>('oldest');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const order: 'newest' | 'oldest' = view === 'newest' ? 'newest' : 'oldest';

  const comments = useStoryCommentsQuery(storyId, { depth: INLINE_MAX_DEPTH, order });
  // Live comments: the stream re-fetches the loaded pages on each new arrival, so
  // comments appear in real time (no "load new" button). Side-effect only.
  useCommentStream(storyId);
  const debates = useStoryDebatesQuery(storyId);
  // The home room supplies BOTH the interpretation lenses (for the reading FILTER
  // below) AND the member's chosen POSTING lens (`my_lens_id`) — the two are now
  // fully decoupled: the filter lens is what you READ, the membership lens is what
  // you POST as (chosen at join / via the room's lens button, WS-G.2.2).
  const room = useRoomQuery(roomId ?? '', roomId !== undefined);
  // SCOI "Where interpretations differ" (WS-H): shown right after the composer so
  // the lens-divergence context sits with the conversation, not at page bottom.
  const interpretations = useStoryInterpretationsQuery(storyId);

  const all = comments.data?.comments ?? [];
  const roomLenses = room.data?.lenses ?? [];
  const lensCounts = new Map<string, number>();
  for (const comment of all) {
    const id = comment.metadata.lens_id;
    if (id !== undefined) lensCounts.set(id, (lensCounts.get(id) ?? 0) + 1);
  }
  // A `lens:<id>` view resolves to a real room lens (self-heals if it vanishes).
  // This is the READING FILTER only — it scopes which comments are shown and
  // never the lens a new comment is posted as.
  const activeLensId = lensIdOfView(view);
  const activeLens =
    activeLensId !== null
      ? (roomLenses.find((lens) => lens.lens_id === activeLensId) ?? null)
      : null;
  // The member's POSTING lens for this room (null = Undecided): what a top-level
  // comment written here joins. Shown to the composer for transparency; changed
  // ONLY on the room page, never here. Offered only when the room has lenses.
  const postingLens =
    roomLenses.length > 0
      ? {
          id: room.data?.my_lens_id ?? null,
          name: lensDisplayName(room.data?.my_lens_id ?? null, roomLenses),
        }
      : null;
  // Offer the view control when there is something to sort OR a lens to filter by.
  // A lens is a reading context, never a vote.
  const showViewControl = all.length >= 2 || roomLenses.length >= 2;
  const visible =
    activeLens !== null
      ? all.filter((comment) => comment.metadata.lens_id === activeLens.lens_id)
      : view === 'participation'
        ? byParticipationDesc(all)
        : all;

  // The view selector's trigger sits on the LEFT of the composer's action row,
  // opposing the Comment button on the right (visual symmetry); its label is the
  // active view (e.g. "Oldest first" / "Lens: Skeptical"), so no separate word or
  // lens hint is needed. The modal Sheet it opens is rendered below.
  const viewButton = showViewControl ? (
    <Button
      variant="secondary"
      onClick={() => setSelectorOpen(true)}
      aria-haspopup="dialog"
      aria-label={`Sort and filter comments — ${viewLabel(view, roomLenses)}`}
    >
      {viewLabel(view, roomLenses)}
      <Icon name="chevron-down" className="size-4" />
    </Button>
  ) : null;

  return (
    <section id="comments" className="mt-6 flex flex-col gap-4" aria-label="Conversation">
      {debates.data ? <DebatePanel debates={debates.data.debates} /> : null}
      <CommentComposer
        storyId={storyId}
        threadId={threadId}
        leadingAction={viewButton}
        {...(postingLens ? { postingLens } : {})}
      />
      {showViewControl ? (
        <Sheet
          open={selectorOpen}
          onClose={() => setSelectorOpen(false)}
          title="Sort & filter comments"
        >
          <CommentViewSelector
            view={view}
            roomLenses={roomLenses}
            lensCounts={lensCounts}
            onSelect={(next) => {
              setView(next);
              setSelectorOpen(false);
            }}
          />
        </Sheet>
      ) : null}
      {interpretations.data ? (
        <WhereInterpretationsDiffer data={interpretations.data} storyId={storyId} />
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
          {activeLens !== null
            ? `No comments in the ${activeLens.name} lens yet. Post one to start this reading.`
            : 'No comments yet. Start the conversation with context or a source.'}
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
