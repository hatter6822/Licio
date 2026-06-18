// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CommentItem } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentSection } from './CommentSection.js';

const mutate = vi.fn();
const loadMore = vi.fn();
const refetch = vi.fn();
const drain = vi.fn();
const recordReplyDepth = vi.fn();

let queryState: {
  data?: {
    comments: CommentItem[];
    next_cursor: string | null;
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

vi.mock('../../lib/queries.js', () => ({
  useStoryCommentsQuery: vi.fn((_storyId: string, _filters: Record<string, string>) => ({
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
      overview: { comment_count: 0, sources_count: 0, corrections_count: 0 },
      summary: null,
    },
  };
  streamState = { newComments: [] };
  mutationState = {};
  mutate.mockReset();
  loadMore.mockReset();
  refetch.mockReset();
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
        overview: { comment_count: 0, sources_count: 0, corrections_count: 0 },
        summary: null,
      },
    };
    rerender(<CommentSection storyId={storyId} threadId={threadId} />);
    expect(
      screen.getByText('No comments yet. Start the conversation with context or a source.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/like|upvote|karma|reaction/i)).not.toBeInTheDocument();
  });

  it('renders summaries, typed comments, media, reply previews, live stream prompts, and pagination', async () => {
    const reply = comment({
      contribution_id: '55555555-5555-4555-8555-555555555555',
      parent_contribution_id: '33333333-3333-4333-8333-333333333333',
      author_display_name: null,
      author_handle: null,
      body: '',
      depth: 1,
      reply_count: 0,
    });
    queryState = {
      hasMore: true,
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
            reply_count: 3,
            has_more_replies: true,
          }),
          comment({
            contribution_id: '77777777-7777-4777-8777-777777777777',
            type: 'correction',
            author_display_name: null,
            author_handle: 'bob',
          }),
        ],
        next_cursor: 'next',
        overview: { comment_count: 2, sources_count: 1, corrections_count: 1 },
        summary: { body: 'Summary **with context**.' },
      },
    };
    streamState = { newComments: [{ contribution_id: 'new' }, { contribution_id: 'newer' }] };

    renderSection();

    expect(screen.getByLabelText('Conversation overview')).toBeInTheDocument();
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('Correction')).toBeInTheDocument();
    expect(screen.getByAltText('Chart from source')).toBeInTheDocument();
    expect(screen.getByText(/Animated GIF hidden/)).toBeInTheDocument();
    expect(screen.getByText('Deleted account')).toBeInTheDocument();
    expect(screen.getByText('Load all 3 replies')).toBeInTheDocument();
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 0);
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 1);

    await userEvent.click(screen.getByRole('button', { name: 'Show 2 new comments' }));
    expect(drain).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('limits story comments to one visual reply layer and focused comments to two', () => {
    const grandchild = comment({
      contribution_id: '88888888-8888-4888-8888-888888888888',
      parent_contribution_id: '55555555-5555-4555-8555-555555555555',
      body: 'A deeper reply.',
      depth: 2,
    });
    const child = comment({
      contribution_id: '55555555-5555-4555-8555-555555555555',
      parent_contribution_id: '33333333-3333-4333-8333-333333333333',
      body: 'A first-layer reply.',
      depth: 1,
      replies: [grandchild],
      reply_count: 1,
    });
    queryState = {
      data: {
        comments: [comment({ replies: [child], reply_count: 1 })],
        next_cursor: null,
        overview: { comment_count: 3, sources_count: 0, corrections_count: 0 },
        summary: null,
      },
    };

    const { rerender } = renderSection();
    expect(screen.getByText('A first-layer reply.')).toBeInTheDocument();
    expect(screen.queryByText('A deeper reply.')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Show More' })).toHaveAttribute(
      'href',
      `/stories/${storyId}/comments`,
    );
    expect(screen.getByRole('link', { name: 'Continue this thread (1 reply)' })).toHaveAttribute(
      'href',
      `/stories/${storyId}/comments?root=${child.contribution_id}`,
    );

    rerender(<CommentSection storyId={storyId} threadId={threadId} surface="conversation" />);
    expect(screen.getByText('A deeper reply.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to story comments' })).toHaveAttribute(
      'href',
      `/stories/${storyId}#comments`,
    );
  });

  it('submits top-level comments and replies with the comment write contract', async () => {
    const parent = comment();
    queryState = {
      data: {
        comments: [parent],
        next_cursor: null,
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
