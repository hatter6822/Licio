// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7 inline comment section: up to TWO nested reply layers in visual scope; a
// thread that continues deeper (or a comment with more direct replies than shown)
// links to the dedicated comment-centric page rather than nesting further, and
// more TOP-LEVEL comments load in place via "Load more comments".
import type {
  CommentItem,
  DebateArenaSummary,
  LensPublic,
  StoryInterpretationsResponse,
} from '@licio/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentSection } from './CommentSection.js';

const mutate = vi.fn();
const refetch = vi.fn();
const loadMore = vi.fn();
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
let mutationState: { isPending?: boolean; isError?: boolean };
let debatesState: { debates: DebateArenaSummary[] };
let interpretationsState: StoryInterpretationsResponse | null = null;
let lensesState: LensPublic[] = [];
// WS-G.2.2 — the member's chosen POSTING lens for the room (null = Undecided),
// now fully separate from the reading/filter lens the view control selects.
let myLensIdState: string | null = null;

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
  // Honor the `order` arg exactly as the server does: `newest` returns the same
  // roots reversed (the store's chronological order), so a sort toggle is
  // behaviorally testable, not just a label change.
  useStoryCommentsQuery: vi.fn((_storyId: string, options?: { order?: 'newest' | 'oldest' }) => {
    const base = queryState.data;
    const data =
      base && options?.order === 'newest'
        ? { ...base, comments: [...base.comments].reverse() }
        : base;
    return {
      data,
      isError: queryState.isError ?? false,
      isLoading: queryState.isLoading ?? false,
      hasMore: queryState.hasMore ?? false,
      isFetchingMore: queryState.isFetchingMore ?? false,
      loadMore,
      refetch,
    };
  }),
  useStoryDebatesQuery: vi.fn(() => ({ data: debatesState })),
  useStoryInterpretationsQuery: vi.fn(() => ({ data: interpretationsState })),
  // The room detail supplies the reading lenses AND the member's posting lens.
  useRoomQuery: vi.fn(() => ({ data: { lenses: lensesState, my_lens_id: myLensIdState } })),
  useCreateCommentMutation: vi.fn(() => ({
    isPending: mutationState.isPending ?? false,
    isError: mutationState.isError ?? false,
    mutate,
  })),
}));

vi.mock('../../lib/comment-stream.js', () => ({
  // Live comments arrive via query invalidation inside the hook (side-effect
  // only); the section just re-renders the refetched pages. No return value, no
  // "load new" button to click.
  useCommentStream: vi.fn(),
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
  mutationState = {};
  debatesState = { debates: [] };
  interpretationsState = null;
  lensesState = [];
  myLensIdState = null;
  mutate.mockReset();
  refetch.mockReset();
  loadMore.mockReset();
  recordReplyDepth.mockReset();
  vi.stubGlobal('crypto', { randomUUID: () => '44444444-4444-4444-8444-444444444444' });
});

describe('CommentSection', () => {
  it('WS-T — sources are inline body links (no modal), plus the Incorrect tag', () => {
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
    // The source is a clickable INLINE link in the body itself — there is no
    // "Sources (N)" button and no modal.
    expect(screen.queryByRole('button', { name: /sources/i })).not.toBeInTheDocument();
    const sourceLink = screen.getByRole('link', { name: 'official record' });
    expect(sourceLink).toHaveAttribute('href', 'https://example.org/evidence');
    // The "Correct" action is offered on a plain comment.
    const correctButtons = screen.getAllByRole('button', { name: /correct/i });
    expect(correctButtons.length).toBeGreaterThan(0);
    // Every comment is reportable via an icon-only flag (mirrors story cards).
    expect(screen.getAllByRole('button', { name: /report this comment/i }).length).toBeGreaterThan(
      0,
    );
  });

  it('WS-T — surfaces a legacy bare DOI citation with visible link text (no empty link)', () => {
    queryState = {
      data: {
        comments: [
          comment({
            contribution_id: '77777777-7777-4777-8777-777777777777',
            body: 'An older sourced claim.',
            // A legacy bare citation (no matching inline body link) with a DOI URL
            // and no title: formatSourceUrl has no host for `doi:`, so the link
            // text must fall back to the full URL and never render empty.
            citations: [{ url: 'doi:10.1000/182' }],
          }),
        ],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 1, sources_count: 1, corrections_count: 0 },
      },
    };
    renderSection();
    const link = screen.getByRole('link', { name: 'doi:10.1000/182' });
    expect(link).toHaveAttribute('href', 'doi:10.1000/182');
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
          resolve_due_at: '2999-01-01T01:00:00.000Z',
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
    // Anyone — especially the incumbent author — reaches the arena to make
    // their case while it is live, even though the `Correct` button is
    // disabled here.
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
            citations: [{ url: 'https://example.org/source' }],
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

    renderSection();

    expect(screen.getByText('Sourced')).toBeInTheDocument();
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

  const twoLenses = (): void => {
    lensesState = [
      lens({ lens_id: LENS_SKEPTICAL, name: 'Skeptical', lens_type: 'skeptical' }),
      lens({ lens_id: LENS_INDUSTRY, name: 'Industry', lens_type: 'policy' }),
    ];
  };

  // The ONE comment "view" control is a BUTTON that opens a modal Sheet — it
  // unifies sort with lens filter and scales to any number of lenses. Open it and
  // click an option (scoped inside the dialog so the trigger's own label can't
  // collide).
  async function pickView(
    user: ReturnType<typeof userEvent.setup>,
    optionName: string,
  ): Promise<void> {
    await user.click(screen.getByRole('button', { name: /sort and filter comments/i }));
    const dialog = await screen.findByRole('dialog', { name: /sort & filter comments/i });
    await user.click(within(dialog).getByRole('button', { name: optionName }));
  }

  it('WS-G.2.2 — ONE view control (button + modal) scopes the conversation to a lens', async () => {
    twoLenses();
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
    // Exactly ONE view control (a button) — no separate composer picker/combobox.
    expect(screen.getByRole('button', { name: /sort and filter comments/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('The skeptical reading.')).toBeInTheDocument();
    expect(screen.getByText('The industry reading.')).toBeInTheDocument();

    // Selecting a lens filters the conversation and relabels the button.
    const user = userEvent.setup();
    await pickView(user, 'Skeptical (1)');
    expect(
      screen.getByRole('button', { name: /sort and filter comments — lens: skeptical/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('The skeptical reading.')).toBeInTheDocument();
    expect(screen.queryByText('The industry reading.')).not.toBeInTheDocument();
  });

  it('WS-G.2.2 — the selector offers every room lens even before any comment is tagged', async () => {
    twoLenses(); // no comments tagged yet, but 2 room lenses ⇒ control shows
    const user = userEvent.setup();
    renderSection(true);
    await user.click(screen.getByRole('button', { name: /sort and filter comments/i }));
    const dialog = await screen.findByRole('dialog', { name: /sort & filter comments/i });
    expect(within(dialog).getByRole('button', { name: 'Skeptical (0)' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Industry (0)' })).toBeInTheDocument();
    // …and the sort options are always present.
    expect(within(dialog).getByRole('button', { name: 'Newest first' })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Highest participation' }),
    ).toBeInTheDocument();
  });

  it('WS-G.2.2 — a top-level comment posts through the MEMBERSHIP lens, never the filter lens', async () => {
    twoLenses();
    // The member's posting lens is Industry; the reading filter is set to a
    // DIFFERENT lens (Skeptical) — the comment must still join Industry, proving
    // the reading lens can never accidentally become the posting lens.
    myLensIdState = LENS_INDUSTRY;
    mutate.mockImplementation((_payload, options) => options?.onSuccess?.());
    const user = userEvent.setup();
    renderSection(true);

    // The composer states the posting lens for transparency (the membership one).
    expect(screen.getByText(/posting as/i)).toHaveTextContent(/Industry/);

    await pickView(user, 'Skeptical (0)');
    expect(
      screen.getByRole('button', { name: /sort and filter comments — lens: skeptical/i }),
    ).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Write a comment' }), 'A take');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    // Posted lens = the MEMBERSHIP lens (Industry), NOT the Skeptical filter.
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'comment',
        thread_id: threadId,
        body: 'A take',
        lens_id: LENS_INDUSTRY,
      }),
      expect.any(Object),
    );
  });

  it('WS-G.2.2 — an Undecided member (no membership lens) posts no lens, even under a lens filter', async () => {
    twoLenses();
    myLensIdState = null; // Undecided (the default)
    mutate.mockImplementation((_payload, options) => options?.onSuccess?.());
    const user = userEvent.setup();
    renderSection(true);
    // The composer says "Posting as Undecided".
    expect(screen.getByText(/posting as/i)).toHaveTextContent(/Undecided/);
    // Select a lens FILTER — this must NOT tag the comment.
    await pickView(user, 'Skeptical (0)');
    await user.type(screen.getByRole('textbox', { name: 'Write a comment' }), 'A general point');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(mutate.mock.calls[0]?.[0]).not.toHaveProperty('lens_id');
  });

  it('WS-T — "Highest participation" sorts sourced up and debate-losers down', async () => {
    queryState = {
      data: {
        comments: [
          comment({ contribution_id: 'c0000000-0000-4000-8000-000000000001', body: 'Plain take.' }),
          comment({
            contribution_id: 'c0000000-0000-4000-8000-000000000002',
            body: 'Sourced take.',
            citations: [{ url: 'https://example.org/x' }],
          }),
          comment({
            contribution_id: 'c0000000-0000-4000-8000-000000000003',
            body: 'Debate loser.',
            dispute_status: 'incorrect',
          }),
        ],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 3, sources_count: 1, corrections_count: 0 },
      },
    };
    const user = userEvent.setup();
    renderSection();
    await pickView(user, 'Highest participation');
    const sourced = screen.getByText('Sourced take.');
    const plain = screen.getByText('Plain take.');
    const loser = screen.getByText('Debate loser.');
    // sourced (1.35) → plain (1.0) → loser (sunk).
    expect(sourced.compareDocumentPosition(plain) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plain.compareDocumentPosition(loser) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('WS-T — "Newest first" reorders the conversation (server order) and relabels', async () => {
    queryState = {
      data: {
        // Default (oldest) order: the older comment first.
        comments: [
          comment({
            contribution_id: 'd0000000-0000-4000-8000-000000000001',
            body: 'The older one.',
          }),
          comment({
            contribution_id: 'd0000000-0000-4000-8000-000000000002',
            body: 'The newer one.',
          }),
        ],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 2, sources_count: 0, corrections_count: 0 },
      },
    };
    const user = userEvent.setup();
    renderSection();
    // Oldest first: older precedes newer.
    expect(
      screen
        .getByText('The older one.')
        .compareDocumentPosition(screen.getByText('The newer one.')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await pickView(user, 'Newest first');
    // The button relabels AND the list flips (newer precedes older).
    expect(
      screen.getByRole('button', { name: /sort and filter comments — newest first/i }),
    ).toBeInTheDocument();
    expect(
      screen
        .getByText('The newer one.')
        .compareDocumentPosition(screen.getByText('The older one.')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('WS-G.2.2 — hides the view control when there is nothing to sort or filter', () => {
    // One comment, fewer than two lenses ⇒ no control.
    lensesState = [lens({ lens_id: LENS_SKEPTICAL, name: 'Skeptical', lens_type: 'skeptical' })];
    queryState = {
      data: {
        comments: [comment({ contribution_id: 'e1' })],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 1, sources_count: 0, corrections_count: 0 },
      },
    };
    renderSection(true);
    expect(
      screen.queryByRole('button', { name: /sort and filter comments/i }),
    ).not.toBeInTheDocument();
  });

  it('WS-G.2.2 — a reply never carries the posting lens, even for a lensed member', async () => {
    twoLenses();
    // Even with a real MEMBERSHIP posting lens AND a lens filter active, a REPLY
    // stays untagged — only top-level comments join the member's lens.
    myLensIdState = LENS_SKEPTICAL;
    queryState = {
      data: {
        comments: [
          comment({
            metadata: { lens_id: LENS_SKEPTICAL },
            reply_count: 0,
            has_more_replies: false,
          }),
        ],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 1, sources_count: 0, corrections_count: 0 },
      },
    };
    mutate.mockImplementation((_payload, options) => options?.onSuccess?.());
    const user = userEvent.setup();
    renderSection(true);
    await pickView(user, 'Skeptical (1)');
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByRole('textbox', { name: 'Write a reply' }), 'A reply');
    await user.click(screen.getAllByRole('button', { name: 'Reply' }).at(-1) as HTMLElement);
    const replyPayload = mutate.mock.calls.at(-1)?.[0];
    expect(replyPayload).not.toHaveProperty('lens_id');
    expect(replyPayload).toMatchObject({ parent_contribution_id: expect.any(String) });
  });

  it('WS-G.2.2 — the empty state is lens-aware when a lens filters everything out', async () => {
    twoLenses();
    queryState = {
      data: {
        comments: [
          comment({ metadata: { lens_id: LENS_INDUSTRY }, body: 'An industry-only reading.' }),
        ],
        next_cursor: null,
        anchor: null,
        overview: { comment_count: 1, sources_count: 0, corrections_count: 0 },
      },
    };
    const user = userEvent.setup();
    renderSection(true);
    // Filter to Skeptical — no comments carry it, but there ARE comments.
    await pickView(user, 'Skeptical (0)');
    expect(screen.getByText(/no comments in the skeptical lens yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/no comments yet\./i)).not.toBeInTheDocument();
  });

  it('WS-H — renders "Where interpretations differ" right after the composer', () => {
    interpretationsState = {
      story_id: storyId,
      context_state: 'split',
      needs_context: true,
      interpretations: [
        {
          lens_a: 'l1',
          lens_b: 'l2',
          summary: 'These lenses read this differently.',
          disagreement: 0.7,
        },
      ],
    };
    renderSection(true);
    const composer = screen.getByRole('textbox', { name: 'Write a comment' });
    const drawer = screen.getByRole('heading', { name: /where interpretations differ/i });
    // The drawer sits inside the Conversation section AFTER the composer (DOM
    // order), not at the page bottom.
    expect(
      composer.compareDocumentPosition(drawer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('WS-H — omits the interpretations drawer when there is nothing to show', () => {
    interpretationsState = null;
    renderSection(true);
    expect(
      screen.queryByRole('heading', { name: /where interpretations differ/i }),
    ).not.toBeInTheDocument();
  });
});
