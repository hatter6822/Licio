// SPDX-License-Identifier: AGPL-3.0-or-later
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { ApiClientError } from '../../lib/api.js';
import { checkA11y } from '../../test/axe.js';
import { ToastProvider } from '../ui/Toast/index.js';

vi.mock('../../lib/safety-api.js', () => ({
  fetchReviewerStatus: vi.fn(async () => ({ status: 'available' as const })),
  setReviewerStatus: vi.fn(async () => ({ ok: true })),
  fetchReportQueue: vi.fn(),
  fetchCase: vi.fn(),
  fetchAppealQueue: vi.fn(),
  fetchAudit: vi.fn(),
  applyModerationAction: vi.fn(),
  decideAppeal: vi.fn(),
}));

vi.mock('../../lib/auth-api.js', () => ({ verifyTotp: vi.fn() }));

const api = await import('../../lib/safety-api.js');
const authApi = await import('../../lib/auth-api.js');
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

  // `mfa_required` and a role denial are BOTH 403.  Only the enrolling session is
  // marked MFA-verified server-side, so every later sign-in starts unverified —
  // collapsing the two told an authorized steward their role lost access and left
  // them no way back in, while the client already shipped `verifyTotp`.
  describe('MFA verification (WS-D.1.5b)', () => {
    const mfaDenied = (): ApiClientError =>
      new ApiClientError('mfa_required', 'Verify MFA to use the moderation console', 403);

    it('offers the verification form — NOT the access notice — on mfa_required', async () => {
      vi.mocked(api.fetchReportQueue).mockRejectedValue(mfaDenied());
      const { container } = render(<ModerationConsole />, { wrapper: Providers });
      await waitFor(() =>
        expect(screen.getByLabelText(/authenticator or recovery code/i)).toBeInTheDocument(),
      );
      expect(screen.queryByText(/does not have access/i)).not.toBeInTheDocument();
      expect(await checkA11y(container)).toHaveNoViolations();
    });

    it('verifies the submitted code and retries the failed panel', async () => {
      vi.mocked(api.fetchReportQueue).mockRejectedValue(mfaDenied());
      render(<ModerationConsole />, { wrapper: Providers });
      const field = await screen.findByLabelText(/authenticator or recovery code/i);

      // The retry only has something to succeed with once the server stops denying.
      vi.mocked(authApi.verifyTotp).mockResolvedValue(undefined);
      vi.mocked(api.fetchReportQueue).mockResolvedValue({
        emergency: [],
        standard: [],
        next_cursor: null,
        filtered_total: 0,
      });

      await userEvent.type(field, '123456');
      await userEvent.click(screen.getByRole('button', { name: /verify/i }));

      await waitFor(() => expect(authApi.verifyTotp).toHaveBeenCalledWith('123456'));
      // The queue re-fetched and rendered, so the steward is back in the console.
      await waitFor(() =>
        expect(screen.queryByLabelText(/authenticator or recovery code/i)).not.toBeInTheDocument(),
      );
    });

    it('reports a rejected code without revealing which codes exist', async () => {
      vi.mocked(api.fetchReportQueue).mockRejectedValue(mfaDenied());
      render(<ModerationConsole />, { wrapper: Providers });
      const field = await screen.findByLabelText(/authenticator or recovery code/i);
      // 400 = the code itself was refused.  A wrong TOTP and an unknown recovery
      // code must render IDENTICALLY, so the form is not an oracle on which
      // codes exist.
      vi.mocked(authApi.verifyTotp).mockRejectedValue(
        new ApiClientError('invalid_code', 'no', 400),
      );

      await userEvent.type(field, '000000');
      await userEvent.click(screen.getByRole('button', { name: /verify/i }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not accepted/i));
      // Still on the form — a failed verification must not fall through to the
      // dead-end access notice.
      expect(screen.getByLabelText(/authenticator or recovery code/i)).toBeInTheDocument();
    });

    // The three NON-code failures must not be dressed up as "wrong code": an
    // expired session can never succeed on retry, and a throttled steward would
    // otherwise be told to keep hammering the endpoint.
    it.each([
      [401, /session has expired/i, 'an expired session'],
      [429, /too many attempts/i, 'a rate-limited attempt'],
      [503, /unavailable right now/i, 'a server failure'],
    ])('distinguishes %s — %s', async (status, expected) => {
      vi.mocked(api.fetchReportQueue).mockRejectedValue(mfaDenied());
      render(<ModerationConsole />, { wrapper: Providers });
      const field = await screen.findByLabelText(/authenticator or recovery code/i);
      vi.mocked(authApi.verifyTotp).mockRejectedValue(new ApiClientError('x', 'no', status));

      await userEvent.type(field, '123456');
      await userEvent.click(screen.getByRole('button', { name: /verify/i }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(expected));
      expect(screen.getByRole('alert')).not.toHaveTextContent(/not accepted/i);
    });

    it('treats a NETWORK failure as transient, not as a rejected code', async () => {
      vi.mocked(api.fetchReportQueue).mockRejectedValue(mfaDenied());
      render(<ModerationConsole />, { wrapper: Providers });
      const field = await screen.findByLabelText(/authenticator or recovery code/i);
      vi.mocked(authApi.verifyTotp).mockRejectedValue(new TypeError('Failed to fetch'));

      await userEvent.type(field, '123456');
      await userEvent.click(screen.getByRole('button', { name: /verify/i }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(/unavailable right now/i),
      );
    });

    it('accepts a LETTER-bearing recovery code (the field is not digits-only)', async () => {
      // `generateRecoveryCodes` emits Crockford base32 — an `inputMode="numeric"`
      // virtual keyboard would make this untypeable on mobile, exactly when the
      // authenticator is the thing that is unavailable.
      vi.mocked(api.fetchReportQueue).mockRejectedValue(mfaDenied());
      render(<ModerationConsole />, { wrapper: Providers });
      const field = await screen.findByLabelText(/authenticator or recovery code/i);
      expect(field).toHaveAttribute('inputmode', 'text');

      vi.mocked(authApi.verifyTotp).mockResolvedValue(undefined);
      vi.mocked(api.fetchReportQueue).mockResolvedValue({
        emergency: [],
        standard: [],
        next_cursor: null,
        filtered_total: 0,
      });
      await userEvent.type(field, 'K4RM9-T2XQ7');
      await userEvent.click(screen.getByRole('button', { name: /verify/i }));
      await waitFor(() => expect(authApi.verifyTotp).toHaveBeenCalledWith('K4RM9-T2XQ7'));
    });
  });
});
