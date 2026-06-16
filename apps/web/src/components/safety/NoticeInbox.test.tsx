// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.3d notice inbox: the Appeal affordance shows ONLY while a notice is
// appealable AND no appeal has been filed yet; once an appeal is pending the
// notice carries an `appeal_status` and the inbox shows "under review" instead
// of a button that would 409 (the duplicate-appeal path).
import type { ModerationNoticeListResponse, ModerationNoticeView } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { ToastProvider } from '../ui/Toast/index.js';

vi.mock('../../lib/safety-api.js', () => ({
  fetchModerationNotices: vi.fn(),
  createAppeal: vi.fn(),
  markNoticeRead: vi.fn(),
}));

const api = await import('../../lib/safety-api.js');
const { NoticeInbox } = await import('./NoticeInbox.js');

function Providers({ children }: { children: ReactNode }): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <I18nProvider locale="en">
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

const NOW = new Date('2026-05-01T00:00:00.000Z').toISOString();
const notice = (over: Partial<ModerationNoticeView> = {}): ModerationNoticeView => ({
  notice_id: '00000000-0000-4000-8000-0000000000n1',
  kind: 'action',
  action_id: '00000000-0000-4000-8000-0000000000ac',
  title: 'Your content was hidden',
  body: 'A moderation action was taken.',
  reason_code: 'MOD_HARASS_001',
  appealable: true,
  appeal_status: null,
  created_at: NOW,
  read_at: null,
  ...over,
});

function withList(notices: ModerationNoticeView[]): void {
  const list: ModerationNoticeListResponse = {
    notices,
    next_cursor: null,
    unread_count: notices.filter((n) => n.read_at === null).length,
  };
  vi.mocked(api.fetchModerationNotices).mockResolvedValue(list);
}

describe('NoticeInbox appeal affordance', () => {
  it('offers Appeal for an un-appealed appealable notice', async () => {
    withList([notice()]);
    render(<NoticeInbox />, { wrapper: Providers });
    expect(await screen.findByRole('button', { name: 'Appeal' })).toBeInTheDocument();
    expect(screen.queryByText(/under review/i)).not.toBeInTheDocument();
  });

  it('hides Appeal and shows "under review" once an appeal is pending', async () => {
    withList([notice({ appeal_status: 'pending' })]);
    render(<NoticeInbox />, { wrapper: Providers });
    expect(await screen.findByText(/under review/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Appeal' })).not.toBeInTheDocument();
  });

  it('opens the appeal dialog when Appeal is clicked', async () => {
    withList([notice()]);
    render(<NoticeInbox />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: 'Appeal' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Submit appeal' })).toBeInTheDocument(),
    );
  });

  it('loads older notices via the cursor', async () => {
    vi.mocked(api.fetchModerationNotices).mockImplementation(async (cursor?: string) =>
      cursor
        ? {
            notices: [
              notice({ notice_id: '00000000-0000-4000-8000-0000000000n2', title: 'Older notice' }),
            ],
            next_cursor: null,
            unread_count: 2,
          }
        : {
            notices: [
              notice({ notice_id: '00000000-0000-4000-8000-0000000000n1', title: 'Newer notice' }),
            ],
            next_cursor: 'cursor-1',
            unread_count: 2,
          },
    );
    render(<NoticeInbox />, { wrapper: Providers });
    expect(await screen.findByText('Newer notice')).toBeInTheDocument();
    expect(screen.queryByText('Older notice')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load older/i }));
    expect(await screen.findByText('Older notice')).toBeInTheDocument();
  });
});
