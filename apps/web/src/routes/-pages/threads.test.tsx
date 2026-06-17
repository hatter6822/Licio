// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.3.3 — the `/threads` tab lists the conversations the reader may see, each
// linking into its thread. Before this listing the tab was a hardcoded empty
// state, so seeded/active threads were invisible to users; these tests pin the
// list, the contribution-count framing, the genuine empty state, and a11y.
import type { ThreadListResponse, ThreadSummary } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import { ThreadsPage } from './threads.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode;
    className?: string;
    'aria-label'?: string;
  }) => (
    <a href="#test" className={className} aria-label={ariaLabel}>
      {children}
    </a>
  ),
  useNavigate: () => () => {},
  useParams: () => ({}),
  useSearch: () => ({ branch: 'overview' }),
}));

// Focus management uses the router; the page content is what we assert here.
vi.mock('./usePageFocus.js', () => ({ usePageFocus: () => {} }));

const useThreadsQuery = vi.hoisted(() => vi.fn());
vi.mock('../../lib/queries.js', () => ({ useThreadsQuery: () => useThreadsQuery() }));

function thread(over: Partial<ThreadSummary>): ThreadSummary {
  return {
    thread_id: 't1',
    story_id: 's1',
    room_id: 'r1',
    branch_index: 0,
    title: 'River levels in May',
    conversation_state: 'active',
    safety_state: 'normal',
    contribution_count: 0,
    created_at: '2026-06-11T12:00:00.000Z',
    updated_at: '2026-06-11T12:00:00.000Z',
    ...over,
  };
}

function queryResult(over: Record<string, unknown>) {
  return { data: undefined, isLoading: false, isError: false, refetch: () => {}, ...over };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  useThreadsQuery.mockReset();
});

describe('ThreadsPage (WS-G.3.3 directory)', () => {
  it('lists conversations with titles and contribution counts, each a link', () => {
    const data: ThreadListResponse = {
      items: [
        thread({ thread_id: 't1', title: 'River levels in May', contribution_count: 3 }),
        thread({ thread_id: 't2', title: 'Recall petition', contribution_count: 1 }),
      ],
      nextCursor: null,
    };
    useThreadsQuery.mockReturnValue(queryResult({ data }));
    renderPage();

    expect(screen.getByText('River levels in May')).toBeInTheDocument();
    expect(screen.getByText('Recall petition')).toBeInTheDocument();
    expect(screen.getByText('3 contributions')).toBeInTheDocument();
    // Singular framing for exactly one contribution.
    expect(screen.getByText('1 contribution')).toBeInTheDocument();
    // Two tappable rows (the mocked Link renders an anchor).
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('shows a state chip for a non-active conversation', () => {
    useThreadsQuery.mockReturnValue(
      queryResult({
        data: {
          items: [thread({ conversation_state: 'resolved', contribution_count: 5 })],
          nextCursor: null,
        },
      }),
    );
    renderPage();
    expect(screen.getByText('resolved')).toBeInTheDocument();
  });

  it('renders the empty state when there are no conversations', () => {
    useThreadsQuery.mockReturnValue(queryResult({ data: { items: [], nextCursor: null } }));
    renderPage();
    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    useThreadsQuery.mockReturnValue(
      queryResult({
        data: {
          items: [thread({ title: 'River levels in May', contribution_count: 3 })],
          nextCursor: null,
        },
      }),
    );
    const { container } = renderPage();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
