// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7 inline comment section: up to TWO nested reply layers in visual scope; a
// thread that continues deeper (or a comment with more direct replies than shown)
// links to the dedicated comment-centric page rather than nesting further, and
// more TOP-LEVEL comments load in place via "Load more comments".
import type { CommentItem, DebateArenaSummary, LensPublic } from '@licio/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoomVantageStore } from '../../stores/room-vantage.js';
import { CommentSection } from './CommentSection.js';

const mutate = vi.fn();
const refetch = vi.fn();
const loadMore = vi.fn();
const drain = vi.fn();
const recordReplyDepth = vi.fn();

let queryState: {
  data?: {
    comments: CommentItem[];
    next_cursor: string | null;
    anchor: CommentItem | null;
    overview: { comment_count: number; sources_count: number; corrections_count: number };
  };
  isError?: boolean;
  isLoading?: boolean;
  hasMore?: boolean;
  isFetchingMore?: boolean;
};
let streamState: { newComments: unknown[] };
let mutationState: { isPending?: boolean; isError?: boolean };
let debatesState: { debates: DebateArenaSummary[] };
let lensesState: LensPublic[] = [];

// Render the router Link as a real anchor whose href reflects `to` with the
// params interpolated and the search serialized, so destinations are assertable.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    search,
    hash,
    className,
  }: {
    children?: ReactNode;
    to?: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    hash?: string;
    className?: string;
  }) => {
    let href = to ?? '#';
    for (const [key, value] of Object.entries(params ?? {})) {
      href = href.replace(`$${key}`, value);
    }
    const query =
      search && Object.keys(search).length > 0 ? `?${new URLSearchParams(search).toString()}` : '';
    return (
      <a href={`${href}${query}${hash ? `#${hash}` : ''}`} className={className}>
        {children}
      </a>
    );
  },
  useNavigate: () => vi.fn(),
}));

vi.mock('../../lib/queries.js', () => ({
  useStoryCommentsQuery: vi.fn(() => ({
    data: queryState.data,
    isError: queryState.isError ?? false,
    isLoading: queryState.isLoading ?? false,
    hasMore: queryState.hasMore ?? false,
    isFetchingMore: queryState.isFetchingMore ?? false,
    loadMore,
    refetch,
  })),
  useStoryDebatesQuery: vi.fn(() => ({ data: debatesState })),
  useRoomLensesQuery: vi.fn(() => ({ data: lensesState })),
  useCreateCommentMutation: vi.fn(() => ({
    isPending: mutationState.isPending ?? false,
    isError: mutationState.isError ?? false,
    mutate,
  })),
}));

vi.mock('../../lib/comment-stream.js', () => ({
  useCommentStream: vi.fn(() => ({ newComments: streamState.newComments, drain })),
}));

vi.mock('../../signals/runtime.js', () => ({
  getSignalProcessor: vi.fn(() => ({ recordReplyDepth })),
}));

const storyId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';

function comment(overrides: Partial<CommentItem> = {}): CommentItem {
  return {
    contribution_id: '33333333-3333-4333-8333-333333333333',
    thread_id: threadId,
    type: 'comment',
    body: 'A contextual comment.',
    citations: [],
    metadata: {},
    target_claim_id: null,
    parent_contribution_id: null,
    author_handle: 'alice',
    author_display_name: 'Alice',
    is_author: false,
    created_at: '2026-06-18T00:00:00.000Z',
    updated_at: '2026-06-18T00:00:00.000Z',
    edited: false,
    depth: 0,
    child_count: 1,
    moderation_state: 'published',
    dispute_status: 'none',
    active_debate_id: null,
    media: [],
    replies: [],
    reply_count: 0,
    has_more_replies: false,
    ...overrides,
  };
}

const roomId = '55555555-5555-4555-8555-555555555555';
const LENS_SKEPTICAL = '66666666-6666-4666-8666-666666666661';
const LENS_INDUSTRY = '66666666-6666-4666-8666-666666666662';

function lens(
  over: Partial<LensPublic> & Pick<LensPublic, 'lens_id' | 'name' | 'lens_type'>,
): LensPublic {
  return {
    room_id: roomId,
    description: null,
    created_at: '2026-06-18T00:00:00.000Z',
    ...over,
  };
}

function renderSection(withRoom = false) {
  return render(
    withRoom ? (
      <CommentSection storyId={storyId} threadId={threadId} roomId={roomId} />
    ) : (
      <CommentSection storyId={storyId} threadId={threadId} />
    ),
  );
}

beforeEach(() => {
  queryState = {
    data: {
      comments: [],
      next_cursor: null,
      anchor: null,
      overview: { comment_count: 0, sources_count: 0, corrections_count: 0 },
    },
  };
  streamState = { newComments: [] };
  mutationState = {};
  debatesState = { debates: [] };
  lensesState = [];
  useRoomVantageStore.setState({ byRoom: {} });
  mutate.mockReset();
  refetch.mockReset();
  loadMore.mockReset();
  drain.mockReset();
  recordReplyDepth.mockReset();
  vi.stubGlobal('crypto', { randomUUID: () => '44444444-4444-4444-8444-444444444444' });
});

describe('CommentSection', () => {
  it('WS-T — the Sourced badge + a Sources footnote modal, and the Incorrect tag', async () => {
    queryState = {
      data: {
        comments: [
          comment({
            contribution_id: '33333333-3333-4333-8333-333333333333',
            body: 'The [official record](https://example.org/evidence) disagrees.',
            citations: [{ url: 'https://example.org/evidence', title: 'official record' }],
          }),
          comment({
            contribution_id: '66666666-6666-4666-8666-666666666666',
            body: 'This one lost a debate.',
            dispute_status: 'incorrect',
          }),
        ],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 2, sources_count: 1, corrections_count: 0 },
      },
    };
    renderSection();
    expect(screen.getByText('Sourced')).toBeInTheDocument();
    expect(screen.getByText('Incorrect')).toBeInTheDocument();
    // Sources are NOT shown as an always-visible list; the footnote modal is
    // closed until the compact "Sources (N)" affordance is used.
    expect(screen.queryByRole('dialog', { name: 'Sources' })).not.toBeInTheDocument();
    const sourcesButton = screen.getByRole('button', { name: 'Sources (1)' });
    await userEvent.click(sourcesButton);
    const dialog = screen.getByRole('dialog', { name: 'Sources' });
    expect(within(dialog).getByText('official record')).toBeInTheDocument();
    expect(within(dialog).getByRole('link')).toHaveAttribute(
      'href',
      'https://example.org/evidence',
    );
    // The "Correct" action is offered on a plain comment, and disabled on the
    // already-decided one.
    const correctButtons = screen.getAllByRole('button', { name: /correct/i });
    expect(correctButtons.length).toBeGreaterThan(0);
    // Every comment is reportable (mirrors stories).
    expect(screen.getAllByRole('button', { name: 'Report' }).length).toBeGreaterThan(0);
  });

  it('WS-T — lists the story’s active debates so a reader can watch one', () => {
    const debateId = '99999999-9999-4999-8999-999999999999';
    debatesState = {
      debates: [
        {
          debate_id: debateId,
          story_id: storyId,
          target_type: 'comment',
          target_contribution_id: '33333333-3333-4333-8333-333333333333',
          challenger_contribution_id: '44444444-4444-4444-8444-444444444444',
          state: 'open',
          edit_deadline_at: '2999-01-01T00:00:00.000Z',
          override_deadline_at: null,
          verdict: null,
          winner: null,
          incumbent_display_name: 'Alice',
          challenger_display_name: 'Bob',
          target_excerpt: 'The vote passed 5-4.',
          created_at: '2026-06-18T00:00:00.000Z',
          updated_at: '2026-06-18T00:00:00.000Z',
        },
      ],
    };
    renderSection();
    const panel = screen.getByRole('complementary', { name: 'Active debates' });
    expect(within(panel).getByText('1 active debate')).toBeInTheDocument();
    expect(within(panel).getByText(/The vote passed 5-4\./)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /view debate/i })).toHaveAttribute(
      'href',
      `/stories/${storyId}/debate/${debateId}`,
    );
  });

  it('WS-T — an under-debate comment links to its live arena', () => {
    const debateId = '88888888-8888-4888-8888-888888888888';
    queryState = {
      data: {
        comments: [
          comment({
            body: 'This claim is being challenged.',
            dispute_status: 'under_debate',
            active_debate_id: debateId,
          }),
        ],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 1, sources_count: 0, corrections_count: 0 },
      },
    };
    renderSection();
    // Anyone — especially the incumbent author — reaches the arena to post their
    // 12-hour position, even though the `Correct` button is disabled here.
    const link = screen.getByRole('link', { name: /view debate/i });
    expect(link).toHaveAttribute('href', `/stories/${storyId}/debate/${debateId}`);
    expect(screen.getByRole('button', { name: 'Correct' })).toBeDisabled();
  });

  it('renders loading, error, and empty states without applause affordances', () => {
    queryState = { isLoading: true };
    const { rerender } = renderSection();
    expect(screen.getByText('Loading comments…')).toBeInTheDocument();

    queryState = { isError: true };
    rerender(<CommentSection storyId={storyId} threadId={threadId} />);
    expect(screen.getByRole('heading', { name: 'Comments unavailable' })).toBeInTheDocument();

    queryState = {
      data: {
        comments: [],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 0, sources_count: 0, corrections_count: 0 },
      },
    };
    rerender(<CommentSection storyId={storyId} threadId={threadId} />);
    expect(
      screen.getByText('No comments yet. Start the conversation with context or a source.'),
    ).toBeInTheDocument();
    // No comments ⇒ no "load more" entry, and never any applause affordance.
    expect(screen.queryByRole('button', { name: /load more comments/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/like|upvote|karma|reaction/i)).not.toBeInTheDocument();
  });

  it('renders two nested layers; a deeper thread links to the dedicated page instead of nesting', () => {
    const grandchildId = '77777777-7777-4777-8777-777777777777';
    // A depth-2 grandchild that itself continues deeper — the inline section must
    // NOT nest a fourth level; it links onward to the page rooted at itself.
    const grandchild = comment({
      contribution_id: grandchildId,
      parent_contribution_id: '55555555-5555-4555-8555-555555555555',
      body: 'A third-level reply that continues deeper.',
      depth: 2,
      reply_count: 3,
      has_more_replies: true,
    });
    const reply = comment({
      contribution_id: '55555555-5555-4555-8555-555555555555',
      parent_contribution_id: '33333333-3333-4333-8333-333333333333',
      body: 'A second-level reply.',
      depth: 1,
      replies: [grandchild],
      reply_count: 1,
    });
    queryState = {
      data: {
        comments: [
          comment({
            type: 'evidence',
            media: [
              {
                upload_id: '66666666-6666-4666-8666-666666666666',
                url: '/v1/uploads/66666666-6666-4666-8666-666666666666',
                alt_text: 'Chart from source',
                kind: 'image',
                content_type: 'image/gif',
                animatable: true,
              },
            ],
            replies: [reply],
            reply_count: 1,
            has_more_replies: false,
          }),
        ],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 3, sources_count: 1, corrections_count: 0 },
      },
    };
    streamState = { newComments: [{ contribution_id: 'new' }, { contribution_id: 'newer' }] };

    renderSection();

    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByAltText('Chart from source')).toBeInTheDocument();
    // BOTH nested layers ARE shown (reply + reply-to-reply)…
    expect(screen.getByText('A second-level reply.')).toBeInTheDocument();
    expect(screen.getByText('A third-level reply that continues deeper.')).toBeInTheDocument();
    // …and the third level's continuation is a LINK to the page rooted at it, not
    // a fourth nested comment article.
    const continueLink = screen.getByRole('link', { name: /continue this thread \(3 replies\)/i });
    expect(continueLink).toHaveAttribute(
      'href',
      `/stories/${storyId}/comments?root=${grandchildId}`,
    );
    // Reply-depth attention is bucketed at the ABSOLUTE depths (0, 1, and 2).
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 0);
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 1);
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 2);
    // No section-level "Load more comments" — everything visible fits the page.
    expect(screen.queryByRole('button', { name: /load more comments/i })).not.toBeInTheDocument();
  });

  it('offers no continuation when a thread fits entirely within the two inline layers', () => {
    // A top-level comment whose reply chain terminates within two layers: nothing
    // continues deeper and no top-level page remains, so there is no continuation.
    const leaf = comment({
      contribution_id: '77777777-7777-4777-8777-777777777777',
      parent_contribution_id: '55555555-5555-4555-8555-555555555555',
      body: 'A fully-shown leaf reply.',
      depth: 2,
      reply_count: 0,
      has_more_replies: false,
    });
    const reply = comment({
      contribution_id: '55555555-5555-4555-8555-555555555555',
      parent_contribution_id: '33333333-3333-4333-8333-333333333333',
      body: 'A fully-shown reply.',
      depth: 1,
      replies: [leaf],
      reply_count: 1,
    });
    queryState = {
      hasMore: false,
      data: {
        comments: [comment({ replies: [reply], reply_count: 1, has_more_replies: false })],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 3, sources_count: 0, corrections_count: 0 },
      },
    };
    renderSection();
    expect(screen.getByText('A fully-shown reply.')).toBeInTheDocument();
    expect(screen.getByText('A fully-shown leaf reply.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more comments/i })).not.toBeInTheDocument();
    // …and no dead "continue"/"show all" link anywhere in the fully-shown thread.
    expect(screen.queryByRole('link', { name: /continue this thread/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /show all/i })).not.toBeInTheDocument();
  });

  it('loads more top-level comments in place when the first page is not the whole thread', async () => {
    queryState = {
      hasMore: true,
      data: {
        comments: [comment({ reply_count: 0, has_more_replies: false })],
        next_cursor: 'next',
        anchor: null,
        overview: { comment_count: 1, sources_count: 0, corrections_count: 0 },
      },
    };
    renderSection();
    // The load-more entry is an in-place BUTTON (not a jump to another page); it
    // never appears as a "show more comments" link.
    expect(screen.queryByRole('link', { name: /show more comments/i })).not.toBeInTheDocument();
    const loadMoreButton = screen.getByRole('button', { name: /load more comments/i });
    await userEvent.click(loadMoreButton);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('drains the live-comment buffer and refetches on the new-comments prompt', async () => {
    queryState = {
      data: {
        comments: [comment()],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 1, sources_count: 0, corrections_count: 0 },
      },
    };
    streamState = { newComments: [{ contribution_id: 'new' }] };
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 new comment' }));
    expect(drain).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('submits top-level comments and replies with the comment write contract', async () => {
    const parent = comment();
    queryState = {
      data: {
        comments: [parent],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 1, sources_count: 0, corrections_count: 0 },
      },
    };
    mutate.mockImplementation((_payload, options) => options?.onSuccess?.());
    renderSection();

    const topLevel = screen.getByRole('textbox', { name: 'Write a comment' });
    await userEvent.type(topLevel, '  Add useful context  ');
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(mutate).toHaveBeenCalledWith(
      {
        type: 'comment',
        thread_id: threadId,
        client_draft_id: '44444444-4444-4444-8444-444444444444',
        body: 'Add useful context',
      },
      expect.any(Object),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const replyBox = screen.getByRole('textbox', { name: 'Write a reply' });
    await userEvent.type(replyBox, 'Reply with evidence');
    await userEvent.click(screen.getAllByRole('button', { name: 'Reply' }).at(-1) as HTMLElement);
    expect(mutate).toHaveBeenLastCalledWith(
      {
        type: 'comment',
        thread_id: threadId,
        client_draft_id: '44444444-4444-4444-8444-444444444444',
        body: 'Reply with evidence',
        parent_contribution_id: parent.contribution_id,
      },
      expect.any(Object),
    );
  });

  it('surfaces composer errors and keeps blank submissions disabled', () => {
    mutationState = { isError: true };
    renderSection();
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Comment could not be posted. Please try again.',
    );
  });

  it('WS-G.2.2 — shows lens filter chips only once two lenses are present, and filters', async () => {
    lensesState = [
      lens({ lens_id: LENS_SKEPTICAL, name: 'Skeptical', lens_type: 'skeptical' }),
      lens({ lens_id: LENS_INDUSTRY, name: 'Industry', lens_type: 'policy' }),
    ];
    queryState = {
      data: {
        comments: [
          comment({
            contribution_id: '77777777-7777-4777-8777-777777777771',
            body: 'The skeptical reading.',
            metadata: { lens_id: LENS_SKEPTICAL },
          }),
          comment({
            contribution_id: '77777777-7777-4777-8777-777777777772',
            body: 'The industry reading.',
            metadata: { lens_id: LENS_INDUSTRY },
          }),
        ],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 2, sources_count: 0, corrections_count: 0 },
      },
    };
    renderSection(true);
    const group = screen.getByRole('group', { name: /filter by lens/i });
    expect(within(group).getByRole('button', { name: /^All \(2\)$/ })).toBeInTheDocument();
    // Both readings are visible under "All".
    expect(screen.getByText('The skeptical reading.')).toBeInTheDocument();
    expect(screen.getByText('The industry reading.')).toBeInTheDocument();

    // Filtering to one lens keeps only its comments; the other reading is gone.
    const user = userEvent.setup();
    await user.click(within(group).getByRole('button', { name: /^Skeptical \(1\)$/ }));
    expect(within(group).getByRole('button', { name: /^Skeptical \(1\)$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('The skeptical reading.')).toBeInTheDocument();
    expect(screen.queryByText('The industry reading.')).not.toBeInTheDocument();
  });

  it('WS-G.2.2 — the composer sends the chosen lens tag and remembers the vantage', async () => {
    lensesState = [lens({ lens_id: LENS_SKEPTICAL, name: 'Skeptical', lens_type: 'skeptical' })];
    mutate.mockImplementation((_payload, options) => options?.onSuccess?.());
    const user = userEvent.setup();
    renderSection(true);

    await user.type(
      screen.getByRole('textbox', { name: 'Write a comment' }),
      'A skeptical take with context',
    );
    await user.click(screen.getByRole('combobox', { name: /reading this as/i }));
    await user.click(screen.getByRole('option', { name: 'Skeptical' }));
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'comment',
        thread_id: threadId,
        body: 'A skeptical take with context',
        lens_id: LENS_SKEPTICAL,
      }),
      expect.any(Object),
    );
    // "Declare once": the choice is remembered for the room.
    expect(useRoomVantageStore.getState().getVantage(roomId)).toBe(LENS_SKEPTICAL);
  });

  it('WS-G.2.2 — hides the lens filter when fewer than two lenses appear', () => {
    lensesState = [lens({ lens_id: LENS_SKEPTICAL, name: 'Skeptical', lens_type: 'skeptical' })];
    queryState = {
      data: {
        comments: [comment({ metadata: { lens_id: LENS_SKEPTICAL } })],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 1, sources_count: 0, corrections_count: 0 },
      },
    };
    renderSection(true);
    expect(screen.queryByRole('group', { name: /filter by lens/i })).not.toBeInTheDocument();
  });

  it('WS-G.2.2 — offers the composer lens picker for a room with lenses', () => {
    lensesState = [lens({ lens_id: LENS_SKEPTICAL, name: 'Skeptical', lens_type: 'skeptical' })];
    renderSection(true);
    expect(screen.getByRole('combobox', { name: /reading this as/i })).toBeInTheDocument();
  });

  it('WS-G.2.2 — prefills the composer from the remembered room vantage', () => {
    useRoomVantageStore.getState().setVantage(roomId, LENS_SKEPTICAL);
    lensesState = [
      lens({ lens_id: LENS_SKEPTICAL, name: 'Skeptical', lens_type: 'skeptical' }),
      lens({ lens_id: LENS_INDUSTRY, name: 'Industry', lens_type: 'policy' }),
    ];
    renderSection(true);
    // The "declare once" vantage is pre-selected on the trigger.
    expect(screen.getByRole('combobox', { name: /reading this as/i })).toHaveTextContent(
      'Skeptical',
    );
  });

  it('WS-G.2.2 — never offers the lens picker on a reply composer (top-level only)', async () => {
    lensesState = [lens({ lens_id: LENS_SKEPTICAL, name: 'Skeptical', lens_type: 'skeptical' })];
    queryState = {
      data: {
        comments: [comment({ reply_count: 0, has_more_replies: false })],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 1, sources_count: 0, corrections_count: 0 },
      },
    };
    const user = userEvent.setup();
    renderSection(true);
    // Open the reply composer on the one comment…
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    expect(screen.getByRole('textbox', { name: 'Write a reply' })).toBeInTheDocument();
    // …and only the TOP-LEVEL composer carries a lens picker (the reply adds none).
    expect(screen.getAllByRole('combobox', { name: /reading this as/i })).toHaveLength(1);
  });
});
