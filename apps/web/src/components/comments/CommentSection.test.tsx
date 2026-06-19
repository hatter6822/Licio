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

function renderSection(props: Partial<React.ComponentProps<typeof CommentSection>> = {}) {
  return render(<CommentSection storyId={storyId} threadId={threadId} {...props} />);
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
      reply_count: 1,
      has_more_replies: true,
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
    expect(screen.getByRole('link', { name: 'Show more comments' })).toHaveAttribute(
      'href',
      `/stories/${storyId}/comments`,
    );
    expect(screen.getByRole('link', { name: 'Show more replies' })).toHaveAttribute(
      'href',
      `/stories/${storyId}/comments?root=${reply.contribution_id}`,
    );
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 0);
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 1);

    await userEvent.click(screen.getByRole('button', { name: 'Show 2 new comments' }));
    expect(drain).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('rebuilds flat focused branch pages into nested reply rows without inline duplicate loading', () => {
    const branchRoot = comment({
      contribution_id: '99999999-9999-4999-8999-999999999999',
      parent_contribution_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      body: 'A focused branch root.',
      depth: 2,
      child_count: 1,
      reply_count: 1,
      has_more_replies: true,
    });
    const child = comment({
      contribution_id: '88888888-8888-4888-8888-888888888888',
      parent_contribution_id: branchRoot.contribution_id,
      body: 'A child row returned flat by the branch API.',
      depth: 3,
      child_count: 1,
      reply_count: 1,
      has_more_replies: true,
    });
    const grandchild = comment({
      contribution_id: '77777777-7777-4777-8777-777777777777',
      parent_contribution_id: child.contribution_id,
      body: 'A grandchild row returned flat by the branch API.',
      depth: 4,
    });
    queryState = {
      data: {
        comments: [branchRoot, child, grandchild],
        next_cursor: null,
        overview: { comment_count: 3, sources_count: 0, corrections_count: 0 },
        summary: null,
      },
    };

    renderSection({
      focused: true,
      visualReplyDepth: 2,
      rootContributionId: branchRoot.contribution_id,
    });

    expect(screen.getByText('A focused branch root.')).toBeInTheDocument();
    expect(screen.getByText('A child row returned flat by the branch API.')).toBeInTheDocument();
    expect(
      screen.getByText('A grandchild row returned flat by the branch API.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load all/ })).not.toBeInTheDocument();
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 2);
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 3);
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 4);
  });

  it('resets visual nesting on the focused branch page so deep roots can keep expanding', () => {
    const deepReply = comment({
      contribution_id: '88888888-8888-4888-8888-888888888888',
      parent_contribution_id: '99999999-9999-4999-8999-999999999999',
      body: 'A reply below a deep branch root.',
      depth: 4,
    });
    const deepRoot = comment({
      contribution_id: '99999999-9999-4999-8999-999999999999',
      parent_contribution_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      body: 'A deep branch root.',
      depth: 3,
      replies: [deepReply],
      reply_count: 1,
    });
    queryState = {
      data: {
        comments: [deepRoot],
        next_cursor: null,
        overview: { comment_count: 2, sources_count: 0, corrections_count: 0 },
        summary: null,
      },
    };

    renderSection({
      focused: true,
      visualReplyDepth: 2,
      rootContributionId: deepRoot.contribution_id,
    });

    expect(screen.getByText('A deep branch root.')).toBeInTheDocument();
    expect(screen.getByText('A reply below a deep branch root.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to story comments' })).toHaveAttribute(
      'href',
      `/stories/${storyId}#comments`,
    );
    expect(screen.getByRole('link', { name: 'Return to top-level conversation' })).toHaveAttribute(
      'href',
      `/stories/${storyId}/comments`,
    );
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 3);
    expect(recordReplyDepth).toHaveBeenCalledWith(storyId, 4);
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
