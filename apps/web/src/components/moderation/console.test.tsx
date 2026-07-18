// SPDX-License-Identifier: AGPL-3.0-or-later
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { ApiClientError } from '../../lib/api.js';
import { checkA11y } from '../../test/axe.js';
import { ToastProvider } from '../ui/Toast/index.js';

vi.mock('../../lib/safety-api.js', () => ({
  fetchReportQueue: vi.fn(),
  fetchCase: vi.fn(),
  fetchAppealQueue: vi.fn(),
  fetchAudit: vi.fn(),
  applyModerationAction: vi.fn(),
  decideAppeal: vi.fn(),
}));

const api = await import('../../lib/safety-api.js');
const { ModerationConsole } = await import('./ModerationConsole.js');

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

afterEach(() => vi.clearAllMocks());

describe('ModerationConsole', () => {
  it('renders the queue with the emergency case first and no axe violations', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue({
      emergency: [
        {
          case_id: '00000000-0000-4000-8000-0000000000e1',
          target_type: 'content',
          target_id: '00000000-0000-4000-8000-0000000000aa',
          content_kind: 'contribution',
          reason_codes: ['MOD_THREAT_001'],
          severity: 'critical',
          status: 'new',
          routed_to: 'emergency',
          report_count: 1,
          assigned_to_handle: null,
          assigned_to_id: null,
          preview: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          sla_due_at: new Date(Date.now() + 1000).toISOString(),
          sla_state: 'approaching',
        },
      ],
      standard: [],
      next_cursor: null,
      filtered_total: 1,
    });
    const { container } = render(<ModerationConsole />, { wrapper: Providers });
    await waitFor(() => expect(screen.getByText(/MOD_THREAT_001/)).toBeInTheDocument());
    // The page header (h1 + back button) is the route page's; the component
    // renders the labelled tabbed workspace — including the Sources tab (the
    // ROLE_EVIDENCE surface presents as "Sources": sourcing is comment-centric).
    expect(screen.getByRole('tablist', { name: 'Console sections' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Sources' })).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('shows an access notice when the server forbids the queue (non-steward)', async () => {
    vi.mocked(api.fetchReportQueue).mockRejectedValue(new ApiClientError('forbidden', 'no', 403));
    render(<ModerationConsole />, { wrapper: Providers });
    await waitFor(() => expect(screen.getByText(/does not have access/i)).toBeInTheDocument());
  });
});
