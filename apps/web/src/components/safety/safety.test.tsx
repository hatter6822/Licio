// SPDX-License-Identifier: AGPL-3.0-or-later
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { checkA11y } from '../../test/axe.js';
import { ToastProvider } from '../ui/Toast/index.js';

vi.mock('../../lib/safety-api.js', () => ({
  fetchSupportContact: vi.fn(),
  submitReport: vi.fn(),
}));
vi.mock('../../offline/queue.js', () => ({ enqueue: vi.fn() }));

const api = await import('../../lib/safety-api.js');
const { ReportButton, ReportSheet } = await import('./ReportSheet.js');
const { SupportContact } = await import('./SupportContact.js');

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

describe('SupportContact', () => {
  it('renders the safety email and emergency resources with no axe violations', async () => {
    vi.mocked(api.fetchSupportContact).mockResolvedValue({
      safety_email: 'safety@licio.app',
      help_center_url: 'https://licio.app/help',
      jurisdiction: null,
      emergency_resources: [
        {
          label: 'Crisis line',
          description: 'Find help near you.',
          url: 'https://example.org',
          phone: null,
        },
      ],
    });
    const { container } = render(<SupportContact />, { wrapper: Providers });
    await waitFor(() => expect(screen.getByText('safety@licio.app')).toBeInTheDocument());
    expect(screen.getByText('Crisis line')).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe('ReportSheet (two-tap)', () => {
  it('lists reasons by category and submits the selected reason', async () => {
    vi.mocked(api.submitReport).mockResolvedValue({
      report_id: '00000000-0000-4000-8000-000000000001',
      status: 'new',
      severity: 'moderate',
      routed_to: 'standard',
      created_at: new Date().toISOString(),
      idempotent: false,
    });
    const onClose = vi.fn();
    const { container } = render(
      <ReportSheet
        open
        onClose={onClose}
        targetType="content"
        targetId="00000000-0000-4000-8000-0000000000aa"
        contentKind="contribution"
      />,
      { wrapper: Providers },
    );
    // Grouped by category.
    expect(screen.getByRole('heading', { name: 'Safety' })).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
    // Two taps: the sheet is open (tap 1), tap a reason (tap 2) → submit.
    await userEvent.click(screen.getByRole('button', { name: /Harassment/ }));
    await waitFor(() => expect(api.submitReport).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.submitReport).mock.calls[0]?.[0]).toMatchObject({
      target_type: 'content',
      reason_code: 'MOD_HARASS_001',
      content_kind: 'contribution',
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ReportButton', () => {
  it('opens the sheet from a labelled text button', async () => {
    render(<ReportButton targetType="content" targetId="00000000-0000-4000-8000-0000000000aa" />, {
      wrapper: Providers,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    expect(screen.getByRole('dialog', { name: 'Report' })).toBeInTheDocument();
  });

  it("icon-only keeps a real name (and takes the caller's), and still opens the sheet", async () => {
    const { container } = render(
      <ReportButton
        iconOnly
        label="Report this story"
        targetType="content"
        targetId="00000000-0000-4000-8000-0000000000aa"
        contentKind="story"
      />,
      { wrapper: Providers },
    );
    const button = screen.getByRole('button', { name: 'Report this story' });
    // Icon-only is a VISUAL economy: no text label, but never an unnamed control.
    expect(button.textContent).toBe('');
    expect(await checkA11y(container)).toHaveNoViolations();

    // The name is also shown sighted, on hover/focus (WCAG 1.4.13).
    button.focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Report this story');

    await userEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Report' })).toBeInTheDocument();
  });
});
