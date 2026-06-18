// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/ui/Toast/index.js';
import { SubmitPage } from './submit.js';

const searchState: { share_url?: string; share_title?: string } = {};

vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => '/submit',
  useSearch: () => searchState,
  useNavigate: () => vi.fn(),
}));

vi.mock('../../lib/queries.js', () => ({
  useRoomsQuery: () => ({ data: { items: [], nextCursor: null } }),
}));

vi.mock('../../perf/marks.js', () => ({
  markInteractionStart: vi.fn(),
  measureInteraction: vi.fn(),
}));

vi.mock('../../offline/index.js', () => ({
  listStoryDrafts: vi.fn(async () => []),
  saveStoryDraft: vi.fn(async () => undefined),
  deleteStoryDraft: vi.fn(async () => undefined),
}));

function renderSubmitPage(): void {
  render(
    <ToastProvider>
      <SubmitPage />
    </ToastProvider>,
  );
}

describe('SubmitPage story-only submission (WS-T.8.3a)', () => {
  beforeEach(() => {
    for (const key of Object.keys(searchState) as Array<keyof typeof searchState>) {
      delete searchState[key];
    }
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.clearAllMocks();
  });

  it('renders the story composer and not the retired contribution composer', async () => {
    renderSubmitPage();
    expect(await screen.findByText('Commons')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /a link/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add contribution/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ask/i })).not.toBeInTheDocument();
  });

  it('uses share-target params to seed the story composer', async () => {
    searchState.share_url = 'https://example.org/shared';
    searchState.share_title = 'Shared source';
    renderSubmitPage();
    expect(await screen.findByDisplayValue('https://example.org/shared')).toBeInTheDocument();
  });
});
