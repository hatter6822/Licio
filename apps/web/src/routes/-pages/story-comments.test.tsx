// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7.2 dedicated comment-centric page: up to two nested reply layers, a
// focused (rooted) anchor whose replies nest INSIDE its article, drill-down
// breadcrumbs, and the page-header upper-left back button to the story.
import type { CommentItem } from '@licio/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
const recordReplyDepth = vi.fn();
const setActiveStory = vi.fn();
let canGoBack: boolean;
let search: { root?: string };
let storyState: { data?: { title: string; thread_id: string | null } };
let commentsState: {
  data?: { comments: CommentItem[]; anchor: CommentItem | null; next_cursor: string | null };
  isError?: boolean;
  isLoading?: boolean;
  hasMore?: boolean;
};

const historyBack = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ storyId: STORY_ID }),
  useSearch: () => search,
  useNavigate: () => navigate,
  // useGoBack (the page-header back button) retraces history; expose a stub
  // router + a canGoBack flag so the hook resolves in the mocked module graph.
  useCanGoBack: () => canGoBack,
  useRouter: () => ({ history: { back: historyBack } }),
  Link: ({
    children,
    to,
    params,
    search: linkSearch,
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
    for (const [key, value] of Object.entries(params ?? {})) href = href.replace(`$${key}`, value);
    const query =
      linkSearch && Object.keys(linkSearch).length > 0
        ? `?${new URLSearchParams(linkSearch).toString()}`
        : '';
    return (
      <a href={`${href}${query}${hash ? `#${hash}` : ''}`} className={className}>
        {children}
      </a>
    );
  },
}));

vi.mock('../../components/a11y/index.js', () => ({ useSpaFocus: vi.fn() }));
vi.mock('../../signals/runtime.js', () => ({
  getSignalProcessor: () => ({ recordReplyDepth, setActiveStory }),
}));
vi.mock('../../lib/queries.js', () => ({
  useStoryQuery: () => storyState,
  useStoryCommentsQuery: () => ({
    data: commentsState.data,
    isError: commentsState.isError ?? false,
    isLoading: commentsState.isLoading ?? false,
    hasMore: commentsState.hasMore ?? false,
    isFetchingMore: false,
    loadMore: vi.fn(),
  }),
  useCreateCommentMutation: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
}));

const { StoryCommentsPage } = await import('./story-comments.js');

const STORY_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = '22222222-2222-4222-8222-222222222222';

function node(id: string, overrides: Partial<CommentItem> = {}): CommentItem {
  return {
    contribution_id: id,
    thread_id: THREAD_ID,
    type: 'comment',
    body: `Comment ${id.slice(0, 4)}`,
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
    child_count: 0,
    moderation_state: 'published',
    media: [],
    replies: [],
    reply_count: 0,
    has_more_replies: false,
    ...overrides,
  };
}

beforeEach(() => {
  navigate.mockReset();
  recordReplyDepth.mockReset();
  setActiveStory.mockReset();
  historyBack.mockReset();
  canGoBack = true;
  search = {};
  storyState = { data: { title: 'Regional water board dataset', thread_id: THREAD_ID } };
  commentsState = { data: { comments: [], anchor: null, next_cursor: null } };
  vi.stubGlobal('crypto', { randomUUID: () => '44444444-4444-4444-8444-444444444444' });
});

describe('StoryCommentsPage (dedicated comment page)', () => {
  it('renders two nested layers unrooted; the deepest visible comment links onward', () => {
    const deep = node('33333333-3333-4333-8333-333333333333', {
      depth: 2,
      body: 'Third-level comment.',
      reply_count: 1,
      has_more_replies: false,
    });
    const mid = node('44444444-4444-4444-8444-444444444444', {
      depth: 1,
      body: 'Second-level comment.',
      replies: [deep],
      reply_count: 1,
    });
    const top = node('55555555-5555-4555-8555-555555555555', {
      depth: 0,
      body: 'Top-level comment.',
      replies: [mid],
      reply_count: 1,
    });
    commentsState = { data: { comments: [top], anchor: null, next_cursor: null } };

    render(<StoryCommentsPage />);

    // All three levels are visible on the page (two nested layers).
    expect(screen.getByText('Top-level comment.')).toBeInTheDocument();
    expect(screen.getByText('Second-level comment.')).toBeInTheDocument();
    expect(screen.getByText('Third-level comment.')).toBeInTheDocument();
    // The third level continues onward via a re-root link, not a fourth nest.
    expect(screen.getByRole('link', { name: /continue this thread \(1 reply\)/i })).toHaveAttribute(
      'href',
      `/stories/${STORY_ID}/comments?root=${deep.contribution_id}`,
    );
    // Unrooted view exposes a top-level composer.
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toBeInTheDocument();
    // The return-to-story control is the page-header upper-left back button (there
    // is no longer a duplicate lower "Back to the story" link).
    expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /back to the story/i })).not.toBeInTheDocument();
  });

  it('marks the story active so reply-depth traversal (§5.3) is captured here', () => {
    render(<StoryCommentsPage />);
    // Without this, the story route cleared the active item before this page
    // mounted, so captureCurrent() would emit no aggregate and traversal would
    // be dropped from the now-scored ActiveAttention dimension. (The story ⇄
    // comments hop is de-duped as a return by setActiveStory's touch-on-leave.)
    expect(setActiveStory).toHaveBeenCalledWith(STORY_ID);
  });

  it('renders the focused anchor with breadcrumbs when rooted', () => {
    const anchorParent = '66666666-6666-4666-8666-666666666666';
    const anchor = node('77777777-7777-4777-8777-777777777777', {
      depth: 2,
      body: 'The focused comment.',
      parent_contribution_id: anchorParent,
      reply_count: 1,
    });
    const child = node('88888888-8888-4888-8888-888888888888', {
      depth: 3,
      body: 'A reply to the focused comment.',
    });
    search = { root: anchor.contribution_id };
    commentsState = { data: { comments: [child], anchor, next_cursor: null } };

    render(<StoryCommentsPage />);

    expect(screen.getByText('Replying within')).toBeInTheDocument();
    expect(screen.getByText('The focused comment.')).toBeInTheDocument();
    expect(screen.getByText('A reply to the focused comment.')).toBeInTheDocument();
    // Breadcrumbs: "All comments" (unrooted) and "Up one level" (the parent).
    expect(screen.getByRole('link', { name: 'All comments' })).toHaveAttribute(
      'href',
      `/stories/${STORY_ID}/comments`,
    );
    expect(screen.getByRole('link', { name: /up one level/i })).toHaveAttribute(
      'href',
      `/stories/${STORY_ID}/comments?root=${anchorParent}`,
    );
  });

  it('records the focused anchor depth even with no rendered replies (§5.3)', () => {
    const anchor = node('77777777-7777-4777-8777-777777777777', {
      depth: 3,
      body: 'A deep focused comment with no replies.',
      reply_count: 0,
    });
    search = { root: anchor.contribution_id };
    commentsState = { data: { comments: [], anchor, next_cursor: null } };

    render(<StoryCommentsPage />);

    // The anchor is its own article (not a CommentNode), so it must record its
    // own depth — else drilling straight to a deep comment contributes no
    // traversal. jsdom has no IntersectionObserver, so the hook records on attach.
    expect(recordReplyDepth).toHaveBeenCalledWith(STORY_ID, 3);
  });

  it('hides the redundant "Up one level" when the anchor is a top-level comment', () => {
    const anchor = node('77777777-7777-4777-8777-777777777777', {
      depth: 0,
      body: 'A top-level focused comment.',
      parent_contribution_id: null,
    });
    search = { root: anchor.contribution_id };
    commentsState = { data: { comments: [], anchor, next_cursor: null } };
    render(<StoryCommentsPage />);
    // "All comments" IS the parent level for a top-level anchor…
    expect(screen.getByRole('link', { name: 'All comments' })).toBeInTheDocument();
    // …so there is no duplicate "Up one level" pointing to the same place.
    expect(screen.queryByRole('link', { name: /up one level/i })).not.toBeInTheDocument();
  });

  it('shows an error state when the focused thread cannot be read', () => {
    search = { root: '99999999-9999-4999-8999-999999999999' };
    commentsState = { isError: true };
    render(<StoryCommentsPage />);
    expect(screen.getByRole('heading', { name: 'Conversation unavailable' })).toBeInTheDocument();
  });

  // Regression: the header back button must RETRACE history, not hard-navigate
  // (push) to the story.  A push-back to the story ping-pongs with the story
  // page's own history-back button (the reported loop).
  it('retraces history from the header back button (no hard navigate)', () => {
    canGoBack = true;
    render(<StoryCommentsPage />);
    fireEvent.click(screen.getByRole('button', { name: /go back/i }));
    expect(historyBack).toHaveBeenCalledTimes(1);
    // It must NOT push a new story entry — that is what created the loop.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls back to the story comment section (replacing) only on a cold load', () => {
    canGoBack = false;
    render(<StoryCommentsPage />);
    fireEvent.click(screen.getByRole('button', { name: /go back/i }));
    expect(historyBack).not.toHaveBeenCalled();
    // The cold-load fallback REPLACES (never pushes) so the synthetic story
    // parent cannot become a forward-loopable child.
    expect(navigate).toHaveBeenCalledWith({
      to: '/stories/$storyId',
      params: { storyId: STORY_ID },
      hash: 'comments',
      replace: true,
    });
  });
});
