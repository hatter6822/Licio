// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2 console panel coverage: the report-queue → review-dialog action
// palette, the appeals panel (overturn/uphold), the ROLE_INTEGRITY incident
// panel (clear/confirm), and the audit viewer — including empty states, the
// access-notice on a forbidden/error response, and the mutation success/error
// toasts.  safety-api is fully mocked so the panels render deterministically.
import type {
  AppealQueueResponse,
  AppealReviewResponse,
  AuditListResponse,
  CaseReviewResponse,
  IncidentQueueResponse,
  ReportQueueResponse,
} from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { ApiClientError } from '../../lib/api.js';
import { ToastProvider } from '../ui/Toast/index.js';

vi.mock('../../lib/safety-api.js', () => ({
  fetchReportQueue: vi.fn(),
  fetchCase: vi.fn(),
  fetchAppealQueue: vi.fn(),
  fetchAppeal: vi.fn(),
  fetchAudit: vi.fn(),
  fetchIncidents: vi.fn(),
  applyModerationAction: vi.fn(),
  decideAppeal: vi.fn(),
  resolveIncident: vi.fn(),
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

const NOW = new Date('2026-05-01T00:00:00.000Z').toISOString();
const CASE_ID = '00000000-0000-4000-8000-0000000000c1';
const TARGET_ID = '00000000-0000-4000-8000-0000000000a1';

const queueWithCase: ReportQueueResponse = {
  emergency: [],
  standard: [
    {
      case_id: CASE_ID,
      target_type: 'content',
      target_id: TARGET_ID,
      content_kind: 'contribution',
      reason_codes: ['MOD_HARASS_001'],
      severity: 'moderate',
      status: 'new',
      routed_to: 'standard',
      report_count: 2,
      assigned_to_handle: null,
      assigned_to_id: null,
      preview: null,
      created_at: NOW,
      updated_at: NOW,
      sla_due_at: new Date(Date.now() + 3_600_000).toISOString(),
      sla_state: 'ok',
    },
  ],
  next_cursor: null,
  filtered_total: 1,
};

const caseReview: CaseReviewResponse = {
  case_id: CASE_ID,
  target_type: 'content',
  target_id: TARGET_ID,
  content_kind: 'contribution',
  status: 'new',
  severity: 'moderate',
  routed_to: 'standard',
  assigned_to_id: null,
  reports: [
    {
      report_id: '00000000-0000-4000-8000-0000000000r1',
      reason_code: 'MOD_HARASS_001',
      context: 'targeted insults',
      evidence_urls: [],
      created_at: NOW,
      reporter_handle: 'reporter_x',
    },
  ],
  thread_context: [
    {
      contribution_id: '00000000-0000-4000-8000-0000000000d1',
      thread_id: '00000000-0000-4000-8000-0000000000e1',
      type: 'answer',
      body: 'the reported contribution text',
      citations: [],
      metadata: {},
      target_claim_id: null,
      parent_contribution_id: null,
      author_handle: 'author_y',
      author_display_name: 'Author Y',
      is_author: false,
      depth: 0,
      child_count: 0,
      moderation_state: 'published',
      edited: false,
      created_at: NOW,
      updated_at: NOW,
    },
  ],
  reported_contribution_id: '00000000-0000-4000-8000-0000000000d1',
  snapshot_body: null,
  user_history: {
    user_id: '00000000-0000-4000-8000-0000000000bb',
    account_age_days: 42,
    reports_by_category: { MOD_HARASS: 1 },
    past_actions: [],
    contribution_count: 3,
    contribution_types: { question: 3 },
    rooms_active_in: 1,
  },
  invariant_signals: {
    mfci: { available: true, state: 'elevated', detail: null },
    scoi: { available: false, state: null, detail: null },
    phi: { available: false, state: null, detail: null },
    hodge: { available: false, state: null, detail: null },
    disclaimer: 'These signals inform review but do not determine outcomes.',
  },
  side_by_side: {
    original_body: 'the original offending text',
    current_body: 'the cleaned-up text',
    original_at: NOW,
    current_at: NOW,
    edited_after_report: true,
  },
  available_actions: ['warn', 'hide', 'remove'],
};

const appealQueue: AppealQueueResponse = {
  items: [
    {
      appeal_id: '00000000-0000-4000-8000-0000000000p1',
      action_id: '00000000-0000-4000-8000-0000000000ac',
      original_action: 'remove',
      original_reason_code: 'MOD_HARASS_001',
      status: 'pending',
      is_ban_appeal: true,
      assigned_to_id: null,
      created_at: NOW,
      sla_due_at: new Date(Date.now() + 3_600_000).toISOString(),
      sla_state: 'approaching',
    },
  ],
  next_cursor: null,
  filtered_total: 1,
};

const appealReview: AppealReviewResponse = {
  appeal_id: appealQueue.items[0]?.appeal_id ?? '',
  action_id: '00000000-0000-4000-8000-0000000000ac',
  status: 'pending',
  original_action: 'remove',
  original_reason_code: 'MOD_HARASS_001',
  original_reviewer_handle: 'first_reviewer',
  original_created_at: NOW,
  appellant_statement: 'I was quoting the policy, not endorsing it.',
  new_evidence: ['https://example.com/context'],
  target_type: 'content',
  target_id: TARGET_ID,
  snapshot_body: 'the reported text',
  user_history: {
    user_id: '00000000-0000-4000-8000-0000000000bb',
    account_age_days: 42,
    reports_by_category: { MOD_HARASS: 1 },
    past_actions: [],
    contribution_count: 3,
    contribution_types: { question: 3 },
    rooms_active_in: 1,
  },
  side_by_side: null,
};

const incidentView = {
  incident_id: '00000000-0000-4000-8000-0000000000i1',
  case_id: CASE_ID,
  target_type: 'content' as const,
  target_id: TARGET_ID,
  report_count: 12,
  window_seconds: 600,
  coordination_score: 0.81,
  severity: 'severe' as const,
  status: 'open' as const,
  summary: 'Volume spike dominated by new accounts.',
  created_at: NOW,
  reviewed_at: null,
  reviewed_by: null,
};
const incidents: IncidentQueueResponse = { incidents: [incidentView], count: 1 };

const auditList: AuditListResponse = {
  items: [
    {
      audit_id: '00000000-0000-4000-8000-0000000000d1',
      event_time: NOW,
      actor_handle: 'steward_a',
      actor_role: 'ROLE_SAFETY',
      action: 'remove',
      reason_code: 'MOD_SPAM_001',
      target_type: 'content',
      target_id: TARGET_ID,
      prior_state: 'visible',
      next_state: 'removed',
      reversible: true,
      linked_action_id: null,
      report_ids: [],
      co_approver_handle: null,
      notes: null,
    },
    {
      audit_id: '00000000-0000-4000-8000-0000000000d2',
      event_time: NOW,
      actor_handle: null, // → "system" (automated block)
      actor_role: null,
      action: 'auto_block',
      reason_code: null, // no reason-code branch
      target_type: 'content',
      target_id: TARGET_ID,
      prior_state: 'visible',
      next_state: 'removed',
      reversible: true,
      linked_action_id: null,
      report_ids: [],
      co_approver_handle: null,
      notes: null,
    },
  ],
  next_cursor: null,
};

afterEach(() => vi.clearAllMocks());

function tab(name: string): void {
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe('ReportQueuePanel + CaseReviewDialog', () => {
  it('opens a case, renders the full review panel, and applies an action', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue(caseReview);
    vi.mocked(api.applyModerationAction).mockResolvedValue({
      action_id: '00000000-0000-4000-8000-0000000000ac',
      action: 'hide',
      reversible: true,
      notice_sent: true,
      appealable: true,
      created_at: NOW,
    });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    // The review dialog shows reporter context, the invariant disclaimer, the
    // unavailable signal, the user history, and the side-by-side diff.
    expect(await screen.findByText(/targeted insults/)).toBeInTheDocument();
    expect(screen.getByText(/do not determine outcomes/)).toBeInTheDocument();
    expect(screen.getAllByText(/unavailable/).length).toBeGreaterThan(0); // scoi/phi/hodge
    expect(screen.getByText(/the original offending text/)).toBeInTheDocument();
    // The reported content + thread context are shown so the reviewer is not
    // deciding blind (WS-J.2.2a).
    expect(screen.getByText(/the reported contribution text/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Apply action/ }));
    await waitFor(() => expect(api.applyModerationAction).toHaveBeenCalledTimes(1));
  });

  it('shows the empty-queue state', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue({
      emergency: [],
      standard: [],
      next_cursor: null,
      filtered_total: 0,
    });
    render(<ModerationConsole />, { wrapper: Providers });
    expect(await screen.findByText(/report queue is clear/i)).toBeInTheDocument();
  });

  it('renders the access notice for a non-forbidden queue error too', async () => {
    vi.mocked(api.fetchReportQueue).mockRejectedValue(
      new ApiClientError('server_error', 'boom', 500),
    );
    render(<ModerationConsole />, { wrapper: Providers });
    expect(await screen.findByText(/does not have access/i)).toBeInTheDocument();
  });

  it('surfaces an error toast when an action is forbidden', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue(caseReview);
    vi.mocked(api.applyModerationAction).mockRejectedValue(
      new ApiClientError('insufficient_capability', 'no', 403),
    );
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Apply action/ }));
    expect(await screen.findByText(/cannot take that action/i)).toBeInTheDocument();
  });
});

describe('AppealsPanel', () => {
  it('requires opening the review before deciding, then overturns with an explanation', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchAppealQueue).mockResolvedValue(appealQueue);
    vi.mocked(api.fetchAppeal).mockResolvedValue(appealReview);
    vi.mocked(api.decideAppeal).mockResolvedValue({
      appeal_id: appealQueue.items[0]?.appeal_id ?? '',
      status: 'overturned',
      notice_sent: true,
      created_at: NOW,
    });
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Appeals');
    expect(await screen.findByText(/ban appeal/i)).toBeInTheDocument();
    // No decide affordance on the queue row — only a Review entry point.
    expect(screen.queryByRole('button', { name: 'Overturn' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    // The review payload is fetched and shown (the appellant statement appears).
    expect(await screen.findByText(/quoting the policy/i)).toBeInTheDocument();
    expect(api.fetchAppeal).toHaveBeenCalledWith(appealQueue.items[0]?.appeal_id);
    // Overturn is blocked (aria-disabled; activation is suppressed) until a
    // written explanation is provided — a click now is a no-op.
    const overturn = screen.getByRole('button', { name: 'Overturn' });
    expect(overturn).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(overturn);
    expect(api.decideAppeal).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/explanation to the user/i), {
      target: { value: 'Quoting policy is not a violation; reversing.' },
    });
    expect(overturn).not.toHaveAttribute('aria-disabled');
    fireEvent.click(overturn);
    await waitFor(() => expect(api.decideAppeal).toHaveBeenCalledTimes(1));
    expect(api.decideAppeal).toHaveBeenCalledWith(appealQueue.items[0]?.appeal_id, {
      decision: 'overturn',
      reason_code: 'MOD_HARASS_001',
      explanation: 'Quoting policy is not a violation; reversing.',
    });
  });

  it('shows the empty + error states', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchAppealQueue).mockResolvedValue({
      items: [],
      next_cursor: null,
      filtered_total: 0,
    });
    const { unmount } = render(<ModerationConsole />, { wrapper: Providers });
    tab('Appeals');
    expect(await screen.findByText(/no appeals are pending/i)).toBeInTheDocument();
    unmount();

    vi.mocked(api.fetchAppealQueue).mockRejectedValue(new ApiClientError('forbidden', 'no', 403));
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Appeals');
    expect(await screen.findByText(/does not have access/i)).toBeInTheDocument();
  });
});

describe('IncidentsPanel', () => {
  it('lists incidents and confirms one (protecting the target)', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchIncidents).mockResolvedValue(incidents);
    vi.mocked(api.resolveIncident).mockResolvedValue({
      incident: incidentView,
      case_status: 'resolved',
    });
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Integrity');
    expect(await screen.findByText(/Volume spike dominated by new accounts/)).toBeInTheDocument();
    expect(screen.getByText(/0\.81/)).toBeInTheDocument(); // coordination score
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(api.resolveIncident).toHaveBeenCalledWith(incidentView.incident_id, 'confirmed'),
    );
  });

  it('shows the empty + error states', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchIncidents).mockResolvedValue({ incidents: [], count: 0 });
    const { unmount } = render(<ModerationConsole />, { wrapper: Providers });
    tab('Integrity');
    expect(await screen.findByText(/no coordinated-report incidents/i)).toBeInTheDocument();
    unmount();

    vi.mocked(api.fetchIncidents).mockRejectedValue(new ApiClientError('forbidden', 'no', 403));
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Integrity');
    expect(await screen.findByText(/does not have access/i)).toBeInTheDocument();
  });
});

describe('AuditPanel', () => {
  it('renders audit rows (reason-coded + system) and the empty state', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchAudit).mockResolvedValue(auditList);
    const { unmount } = render(<ModerationConsole />, { wrapper: Providers });
    tab('Audit log');
    expect(await screen.findByText('remove')).toBeInTheDocument();
    expect(screen.getByText(/MOD_SPAM_001/)).toBeInTheDocument();
    expect(screen.getByText(/system/)).toBeInTheDocument(); // null actor → system
    unmount();

    vi.mocked(api.fetchAudit).mockResolvedValue({ items: [], next_cursor: null });
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Audit log');
    expect(await screen.findByText(/no audit records yet/i)).toBeInTheDocument();
  });
});
