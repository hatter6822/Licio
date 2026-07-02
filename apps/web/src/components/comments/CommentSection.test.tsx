// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7 inline comment section: up to TWO nested reply layers in visual scope; a
// thread that continues deeper (or a comment with more direct replies than shown)
// links to the dedicated comment-centric page rather than nesting further, and
// more TOP-LEVEL comments load in place via "Load more comments".
import type { CommentItem } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    summary: { body: string } | null;
  };
  isError?: boolean;
  isLoading?: boolean;
  hasMore?: boolean;
  isFetchingMore?: boolean;
};
let streamState: { newComments: unknown[] };
let mutationState: { isPending?: boolean; isError?: boolean };

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
    media: [],
    replies: [],
    reply_count: 0,
    has_more_replies: false,
    ...overrides,
  };
}

function renderSection() {
  return render(<CommentSection storyId={storyId} threadId={threadId} />);
}

beforeEach(() => {
  queryState = {
    data: {
      comments: [],
      next_cursor: null,
      anchor: null,
      overview: { comment_count: 0, sources_count: 0, corrections_count: 0 },
      summary: null,
    },
  };
  streamState = { newComments: [] };
  mutationState = {};
  mutate.mockReset();
  refetch.mockReset();
  loadMore.mockReset();
  drain.mockReset();
  recordReplyDepth.mockReset();
  vi.stubGlobal('crypto', { randomUUID: () => '44444444-4444-4444-8444-444444444444' });
});

describe('CommentSection', () => {
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
        summary: null,
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
        summary: { body: 'Summary **with context**.' },
      },
    };
    streamState = { newComments: [{ contribution_id: 'new' }, { contribution_id: 'newer' }] };

    renderSection();

    expect(screen.getByLabelText('Conversation overview')).toBeInTheDocument();
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
        summary: null,
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
        summary: null,
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
        summary: null,
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
        summary: null,
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
});
