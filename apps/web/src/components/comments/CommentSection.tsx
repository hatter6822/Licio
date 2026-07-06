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
  useStoryInterpretationsQuery,
} from '../../lib/queries.js';
import { raisedInteractive, raisedSurface } from '../../lib/surfaces.js';
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
  // both SORTS (newest/oldest/highest-participation) and FILTERS by lens, and — for
  // a lens view — is the lens a comment written here joins. `newest`/`oldest` are
  // server-ordered across the whole thread; the participation sort and lens filter
  // are client-side over the loaded top page (this section is a preview).
  const [view, setView] = useState<CommentViewMode>('oldest');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const order: 'newest' | 'oldest' = view === 'newest' ? 'newest' : 'oldest';

  const comments = useStoryCommentsQuery(storyId, { depth: INLINE_MAX_DEPTH, order });
  const stream = useCommentStream(storyId);
  const debates = useStoryDebatesQuery(storyId);
  const lenses = useRoomLensesQuery(roomId ?? '', roomId !== undefined);
  // SCOI "Where interpretations differ" (WS-H): shown right after the composer so
  // the lens-divergence context sits with the conversation, not at page bottom.
  const interpretations = useStoryInterpretationsQuery(storyId);

  const all = comments.data?.comments ?? [];
  const roomLenses = lenses.data ?? [];
  const lensCounts = new Map<string, number>();
  for (const comment of all) {
    const id = comment.metadata.lens_id;
    if (id !== undefined) lensCounts.set(id, (lensCounts.get(id) ?? 0) + 1);
  }
  // A `lens:<id>` view resolves to a real room lens (self-heals if it vanishes).
  const activeLensId = lensIdOfView(view);
  const activeLens =
    activeLensId !== null
      ? (roomLenses.find((lens) => lens.lens_id === activeLensId) ?? null)
      : null;
  // Offer the control when there is something to sort OR a lens to pick/tag. A
  // lens is a reading context, never a vote.
  const showViewControl = all.length >= 2 || roomLenses.length >= 2;
  const visible =
    activeLens !== null
      ? all.filter((comment) => comment.metadata.lens_id === activeLens.lens_id)
      : view === 'participation'
        ? byParticipationDesc(all)
        : all;

  return (
    <section id="comments" className="mt-6 flex flex-col gap-4" aria-label="Conversation">
      {debates.data ? <DebatePanel storyId={storyId} debates={debates.data.debates} /> : null}
      {showViewControl ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-muted text-sm">Viewing</span>
            <Button
              variant="secondary"
              onClick={() => setSelectorOpen(true)}
              aria-haspopup="dialog"
              aria-label={`Sort and filter comments — ${viewLabel(view, roomLenses)}`}
            >
              {viewLabel(view, roomLenses)}
              <Icon name="chevron-down" className="size-4" />
            </Button>
          </div>
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
        </>
      ) : null}
      <CommentComposer
        storyId={storyId}
        threadId={threadId}
        {...(activeLens ? { activeLens: { id: activeLens.lens_id, name: activeLens.name } } : {})}
      />
      {interpretations.data ? (
        <WhereInterpretationsDiffer data={interpretations.data} storyId={storyId} />
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
