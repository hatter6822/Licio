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
  EvidenceDecisionsResponse,
  EvidenceDecisionView,
  EvidenceQueueResponse,
  IncidentQueueResponse,
  ReportQueueResponse,
} from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { ApiClientError } from '../../lib/api.js';
import { ToastProvider } from '../ui/Toast/index.js';

// The console links to /login from the session-expired notice; render Link as
// a plain anchor (the StoryFeedLink test pattern — no router in these tests).
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children?: ReactNode;
    to?: string;
    className?: string;
  }) => (
    <a href={to ?? '#'} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('../../lib/safety-api.js', () => ({
  fetchReportQueue: vi.fn(),
  fetchCase: vi.fn(),
  fetchAppealQueue: vi.fn(),
  fetchAppeal: vi.fn(),
  fetchAudit: vi.fn(),
  fetchIncidents: vi.fn(),
  fetchEvidenceQueue: vi.fn(),
  fetchEvidenceDecisions: vi.fn(),
  applyEvidenceDecision: vi.fn(),
  applyModerationAction: vi.fn(),
  fetchUrlVerdict: vi.fn(),
  decideAppeal: vi.fn(),
  resolveIncident: vi.fn(),
  assignCase: vi.fn(),
  revertModerationAction: vi.fn(),
  setReviewerStatus: vi.fn(),
  fetchReviewerStatus: vi.fn(),
  exportAudit: vi.fn(),
}));

// The self-assign control needs the signed-in reviewer's own id; nothing else
// in these panels reads the auth store.
const SELF_ID = '00000000-0000-4000-8000-00000000005e';
vi.mock('../../stores/auth.js', () => ({
  useAuthStore: (select: (s: { user: { id: string } | null }) => unknown) =>
    select({ user: { id: SELF_ID } }),
}));

// `exportAudit` writes a file; capture the download instead of performing it.
const savedBlobs: Array<{ filename: string; blob: Blob }> = [];
vi.mock('../../lib/privacy-api.js', () => ({
  saveBlob: (blob: Blob, filename: string) => {
    savedBlobs.push({ filename, blob });
  },
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
      type: 'comment',
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
      dispute_status: 'none',
      active_debate_id: null,
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
const incidents: IncidentQueueResponse = {
  incidents: [incidentView],
  count: 1,
  next_cursor: null,
};

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

const CONTRIB_ID = '00000000-0000-4000-8000-0000000000f1';
const evidenceQueue: EvidenceQueueResponse = {
  items: [
    {
      contribution_id: CONTRIB_ID,
      thread_id: '00000000-0000-4000-8000-0000000000e1',
      story_id: '00000000-0000-4000-8000-0000000000a5',
      story_title: 'Regional water board publishes the dataset',
      type: 'comment',
      body_preview: 'The dataset shows the levels dropped after the filtration upgrade.',
      citations: [
        { url: 'https://example.com/dataset' },
        { url: 'https://example.com/methodology', title: 'Methodology annex' },
      ],
      created_at: NOW,
    },
  ],
  next_cursor: null,
};

const evidenceDecisions: EvidenceDecisionsResponse = {
  items: [
    {
      decision_id: '00000000-0000-4000-8000-0000000000dd',
      contribution_id: CONTRIB_ID,
      story_id: null,
      action: 'mark-primary-source',
      citation_url: 'https://example.com/earlier-primary',
      reason_code: null,
      note: 'Cross-checked against the registry copy.',
      decided_by_handle: 'evidence_steward',
      created_at: NOW,
    },
  ],
  next_cursor: null,
};

const evidenceDecisionView: EvidenceDecisionView = {
  decision_id: '00000000-0000-4000-8000-0000000000de',
  contribution_id: CONTRIB_ID,
  story_id: null,
  action: 'clear',
  citation_url: null,
  reason_code: null,
  note: null,
  decided_by_handle: 'evidence_steward',
  created_at: NOW,
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

  it('a NON-forbidden queue error renders an honest retryable error, never the access notice', async () => {
    // A 500/network failure must not tell an authorized steward their role
    // lost access (the old conflation) — it is a transient error with a retry.
    vi.mocked(api.fetchReportQueue).mockRejectedValue(
      new ApiClientError('server_error', 'boom', 500),
    );
    render(<ModerationConsole />, { wrapper: Providers });
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
    expect(screen.getByText(/not a permissions problem/i)).toBeInTheDocument();
    expect(screen.queryByText(/does not have access/i)).not.toBeInTheDocument();
    // Retry re-runs the failed query against a recovered API.
    vi.mocked(api.fetchReportQueue).mockResolvedValue({
      emergency: [],
      standard: [],
      filtered_total: 0,
      next_cursor: null,
    });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/report queue is clear/i)).toBeInTheDocument();
  });

  it('a FORBIDDEN queue error still renders the access notice', async () => {
    vi.mocked(api.fetchReportQueue).mockRejectedValue(
      new ApiClientError('insufficient_capability', 'no', 403),
    );
    render(<ModerationConsole />, { wrapper: Providers });
    expect(await screen.findByText(/does not have access/i)).toBeInTheDocument();
  });

  it('an EXPIRED session (401) renders the sign-in-again notice, never the retryable error', async () => {
    // The api client flips the auth store to session-expired on a true 401 —
    // retrying cannot succeed, so the panel must say sign in, not "retry".
    vi.mocked(api.fetchReportQueue).mockRejectedValue(
      new ApiClientError('unauthenticated', 'session expired', 401),
    );
    render(<ModerationConsole />, { wrapper: Providers });
    expect(await screen.findByText(/session has expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in again/i })).toHaveAttribute('href', '/login');
    expect(screen.queryByText(/not a permissions problem/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
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

  it('C4: shows report evidence URLs and actions a ROOM case with its real target type', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue({
      ...caseReview,
      target_type: 'room',
      content_kind: null,
      reports: caseReview.reports.map((r) => ({
        ...r,
        evidence_urls: ['https://example.com/evidence-1'],
      })),
      available_actions: ['clear', 'escalate'],
    });
    vi.mocked(api.applyModerationAction).mockResolvedValue({
      action_id: '00000000-0000-4000-8000-0000000000ac',
      action: 'clear',
      reversible: false,
      notice_sent: false,
      appealable: false,
      created_at: NOW,
    });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    // The reporter's evidence link is surfaced before the action palette —
    // as a BUTTON until the WS-J.2.6b verdict resolves (no bypassable href).
    expect(await screen.findByRole('button', { name: /evidence-1/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Apply action/ }));
    await waitFor(() =>
      expect(api.applyModerationAction).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'room' }),
      ),
    );
  });

  it('WS-J.2.6b: an evidence link resolves the server verdict before navigating', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue({
      ...caseReview,
      reports: caseReview.reports.map((r) => ({
        ...r,
        evidence_urls: ['https://example.com/evidence-1'],
      })),
    });

    // malicious → the anchor is replaced by a blocked notice (no navigation).
    vi.mocked(api.fetchUrlVerdict).mockResolvedValue({ verdict: 'malicious' });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    fireEvent.click(await screen.findByRole('button', { name: /evidence-1/ }));
    expect(await screen.findByText(/known malicious site/i)).toBeInTheDocument();
    expect(api.fetchUrlVerdict).toHaveBeenCalledWith('https://example.com/evidence-1');
    expect(screen.queryByRole('button', { name: /evidence-1/ })).not.toBeInTheDocument();
  });

  it('WS-J.2.6b: an unverifiable link warns but leaves the reviewer in control', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue({
      ...caseReview,
      reports: caseReview.reports.map((r) => ({
        ...r,
        evidence_urls: ['https://example.com/evidence-1'],
      })),
    });
    vi.mocked(api.fetchUrlVerdict).mockResolvedValue({ verdict: 'unavailable' });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    fireEvent.click(await screen.findByRole('button', { name: /evidence-1/ }));
    expect(await screen.findByText(/could not verify/i)).toBeInTheDocument();
    // The reviewer IS the human-review path: an explicit fresh-gesture anchor.
    expect(screen.getByRole('link', { name: /open anyway/i })).toBeInTheDocument();
  });

  it('WS-J.2.6b: a clear verdict surfaces the verified noreferrer anchor (no auto-open)', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue({
      ...caseReview,
      reports: caseReview.reports.map((r) => ({
        ...r,
        evidence_urls: ['https://example.com/evidence-1'],
      })),
    });
    vi.mocked(api.fetchUrlVerdict).mockResolvedValue({ verdict: 'clear' });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    fireEvent.click(await screen.findByRole('button', { name: /evidence-1/ }));
    // No window.open: the destination is reporter-supplied, and window.open
    // cannot withhold the Referer — the verified rel="noreferrer noopener"
    // anchor is the ONLY navigation path.
    expect(await screen.findByText(/verified/i)).toBeInTheDocument();
    const anchor = screen.getByRole('link', { name: /open link/i });
    expect(anchor.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('#6 shows the story snapshot AND the thread context for a story-level report', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue({
      ...caseReview,
      content_kind: 'story',
      reported_contribution_id: null, // story-level: the story is NOT in thread_context
      snapshot_body: 'Reported Story Title\n\nThe story excerpt under review.',
      side_by_side: null,
    });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    // BOTH the story snapshot (title/excerpt) AND the surrounding thread render —
    // the steward never decides on a hide/remove without seeing the story.
    expect(await screen.findByText(/Reported Story Title/)).toBeInTheDocument();
    expect(screen.getByText(/the reported contribution text/)).toBeInTheDocument();
  });
});

describe('SourcesPanel (the Sources tab — STEWARD_ROLES.md ROLE_EVIDENCE)', () => {
  function mountSourcesTab(): void {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchEvidenceQueue).mockResolvedValue(evidenceQueue);
    vi.mocked(api.fetchEvidenceDecisions).mockResolvedValue(evidenceDecisions);
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Sources');
  }

  it('renders queue rows with their citations and the recent-decisions trail', async () => {
    mountSourcesTab();
    // Row context: story title, type chip, body preview, created-at.
    expect(
      await screen.findByText('Regional water board publishes the dataset'),
    ).toBeInTheDocument();
    expect(screen.getByText('comment')).toBeInTheDocument();
    expect(screen.getByText(/levels dropped after the filtration upgrade/)).toBeInTheDocument();
    // Each citation renders through CheckedLink — a BUTTON until the WS-J.2.6b
    // malware verdict resolves (no bypassable href).
    expect(screen.getByRole('button', { name: 'https://example.com/dataset' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'https://example.com/methodology' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Methodology annex')).toBeInTheDocument();
    // The reviewability trail below the queue.
    expect(screen.getByText('mark-primary-source')).toBeInTheDocument();
    // Plain substring matchers (not URL-shaped regexes — CodeQL's
    // missing-anchor rule has no false positive to chase on a string).
    expect(
      screen.getByText('https://example.com/earlier-primary', { exact: false }),
    ).toBeInTheDocument();
    // The internal reviewer note renders on the trail (console-only surface).
    expect(
      screen.getByText('Cross-checked against the registry copy.', { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText('evidence_steward', { exact: false })).toBeInTheDocument();
  });

  it('marks a citation as a primary source with that citation url', async () => {
    vi.mocked(api.applyEvidenceDecision).mockResolvedValue({
      ...evidenceDecisionView,
      action: 'mark-primary-source',
      citation_url: 'https://example.com/dataset',
    });
    mountSourcesTab();
    const markButtons = await screen.findAllByRole('button', { name: 'Mark primary source' });
    fireEvent.click(markButtons[0] as HTMLElement);
    await waitFor(() => expect(api.applyEvidenceDecision).toHaveBeenCalledTimes(1));
    expect(api.applyEvidenceDecision).toHaveBeenCalledWith({
      contribution_id: CONTRIB_ID,
      action: 'mark-primary-source',
      citation_url: 'https://example.com/dataset',
    });
    expect(await screen.findByText(/source decision recorded/i)).toBeInTheDocument();
  });

  it('flagging a citation requires a ratified reason code, then posts it', async () => {
    vi.mocked(api.applyEvidenceDecision).mockResolvedValue({
      ...evidenceDecisionView,
      action: 'flag-citation',
      citation_url: 'https://example.com/methodology',
      reason_code: 'MOD_HARASS_001',
    });
    mountSourcesTab();
    const flagButtons = await screen.findAllByRole('button', { name: 'Flag citation' });
    fireEvent.click(flagButtons[1] as HTMLElement); // the second citation
    // The Flag submit stays inert (aria-disabled) until a reason is chosen —
    // a flag without a ratified reason is not reviewable.
    const submit = await screen.findByRole('button', { name: 'Flag' });
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(submit);
    expect(api.applyEvidenceDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('combobox', { name: /reason code/i }));
    fireEvent.click(screen.getByRole('option', { name: /MOD_HARASS_001/ }));
    fireEvent.change(screen.getByLabelText(/internal note/i), {
      target: { value: 'Blog post citing itself.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    await waitFor(() => expect(api.applyEvidenceDecision).toHaveBeenCalledTimes(1));
    expect(api.applyEvidenceDecision).toHaveBeenCalledWith({
      contribution_id: CONTRIB_ID,
      action: 'flag-citation',
      citation_url: 'https://example.com/methodology',
      reason_code: 'MOD_HARASS_001',
      note: 'Blog post citing itself.',
    });
  });

  it('mark reviewed posts a clear (no citation target)', async () => {
    vi.mocked(api.applyEvidenceDecision).mockResolvedValue(evidenceDecisionView);
    mountSourcesTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(api.applyEvidenceDecision).toHaveBeenCalledTimes(1));
    expect(api.applyEvidenceDecision).toHaveBeenCalledWith({
      contribution_id: CONTRIB_ID,
      action: 'clear',
    });
  });

  it('a 409 duplicate reads as an informative toast, not a failure', async () => {
    vi.mocked(api.applyEvidenceDecision).mockRejectedValue(
      new ApiClientError('duplicate_decision', 'already decided', 409),
    );
    mountSourcesTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
    expect(await screen.findByText(/already reviewed by another steward/i)).toBeInTheDocument();
  });

  it('shows the empty state and the access notice on a forbidden queue', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchEvidenceQueue).mockResolvedValue({ items: [], next_cursor: null });
    vi.mocked(api.fetchEvidenceDecisions).mockResolvedValue({ items: [], next_cursor: null });
    const { unmount } = render(<ModerationConsole />, { wrapper: Providers });
    tab('Sources');
    expect(await screen.findByText(/source review queue is clear/i)).toBeInTheDocument();
    expect(await screen.findByText(/no source decisions yet/i)).toBeInTheDocument();
    unmount();

    vi.mocked(api.fetchEvidenceQueue).mockRejectedValue(
      new ApiClientError('insufficient_capability', 'no', 403),
    );
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Sources');
    expect(await screen.findByText(/does not have access/i)).toBeInTheDocument();
  });

  it('pages the source review queue beyond the first page', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchEvidenceDecisions).mockResolvedValue(evidenceDecisions);
    vi.mocked(api.fetchEvidenceQueue).mockImplementation(async (cursor) =>
      cursor
        ? {
            items: evidenceQueue.items.map((row) => ({
              ...row,
              contribution_id: '00000000-0000-4000-8000-0000000000f2',
              story_title: 'Second page of the source review queue',
            })),
            next_cursor: null,
          }
        : { ...evidenceQueue, next_cursor: 'cursor-1' },
    );
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Sources');
    expect(
      await screen.findByText('Regional water board publishes the dataset'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('Second page of the source review queue')).toBeInTheDocument();
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
    vi.mocked(api.fetchIncidents).mockResolvedValue({ incidents: [], count: 0, next_cursor: null });
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

describe('console pagination (Load more)', () => {
  it('B3: pages the report queue beyond the first page', async () => {
    vi.mocked(api.fetchReportQueue).mockImplementation(async (q) =>
      q?.cursor
        ? {
            emergency: [],
            standard: queueWithCase.standard.map((c) => ({
              ...c,
              case_id: '00000000-0000-4000-8000-0000000000p2',
            })),
            next_cursor: null,
            filtered_total: 2,
          }
        : { ...queueWithCase, next_cursor: 'cursor-1' },
    );
    render(<ModerationConsole />, { wrapper: Providers });
    expect(await screen.findByRole('button', { name: /MOD_HARASS_001/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /MOD_HARASS_001/ }).length).toBe(2),
    );
  });

  it('B3: pages the appeal queue beyond the first page', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchAppealQueue).mockImplementation(async (cursor) =>
      cursor
        ? {
            items: appealQueue.items.map((a) => ({
              ...a,
              appeal_id: '00000000-0000-4000-8000-0000000000p2',
            })),
            next_cursor: null,
            filtered_total: 2,
          }
        : { ...appealQueue, next_cursor: 'cursor-1' },
    );
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Appeals');
    expect(await screen.findByRole('button', { name: 'Review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Review' }).length).toBe(2));
  });

  it('B4: pages the integrity queue beyond the first page', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchIncidents).mockImplementation(async (cursor) =>
      cursor
        ? {
            incidents: incidents.incidents.map((i) => ({
              ...i,
              incident_id: '00000000-0000-4000-8000-0000000000p2',
              summary: 'Second batch of coordinated reports',
            })),
            count: 2,
            next_cursor: null,
          }
        : { ...incidents, next_cursor: 'cursor-1' },
    );
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Integrity');
    expect(await screen.findByText(/Volume spike/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText(/Second batch of coordinated reports/)).toBeInTheDocument();
  });

  it('B4: pages the audit log beyond the first page', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchAudit).mockImplementation(async (q) =>
      q?.cursor
        ? {
            items: auditList.items.slice(0, 1).map((e) => ({
              ...e,
              audit_id: '00000000-0000-4000-8000-0000000000d3',
              action: 'restrict',
            })),
            next_cursor: null,
          }
        : { ...auditList, next_cursor: 'cursor-1' },
    );
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Audit log');
    expect(await screen.findByText('remove')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('restrict')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The four console calls that had live server routes and no surface at all
// (`assignCase`, `revertModerationAction`, `setReviewerStatus`, `exportAudit`).
// Each test drives the CONTROL, not the client function, so deleting the
// control fails here rather than leaving a green suite over an unreachable
// endpoint — which is the state these were found in.
// ---------------------------------------------------------------------------
describe('WS-J.2 console surfaces for the previously unreachable routes', () => {
  it('WS-J.2.1d: a reviewer can take an unassigned case, and it posts their own id', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue(caseReview);
    vi.mocked(api.assignCase).mockResolvedValue({ ok: true });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /take this case/i }));
    await waitFor(() => expect(api.assignCase).toHaveBeenCalledWith(CASE_ID, SELF_ID));
  });

  it('WS-J.2.1d: a case already assigned to this reviewer offers no claim button', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue({ ...caseReview, assigned_to_id: SELF_ID });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    expect(await screen.findByText('Assigned to you')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /take this case/i })).not.toBeInTheDocument();
  });

  it('WS-J.2.3b: a prior action can be reverted with the selected reason code', async () => {
    const ACTION_ID = '00000000-0000-4000-8000-0000000000f1';
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue({
      ...caseReview,
      user_history: {
        ...caseReview.user_history,
        past_actions: [
          {
            action_id: ACTION_ID,
            action: 'hide',
            reason_code: 'MOD_HARASS_001',
            created_at: NOW,
            reverted: false,
            reversible: true,
          },
        ],
      },
    });
    vi.mocked(api.revertModerationAction).mockResolvedValue({
      revert_action_id: '00000000-0000-4000-8000-0000000000f2',
      reverted_action_id: ACTION_ID,
      notice_sent: true,
      created_at: NOW,
    });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    // Revert opens its OWN reason prompt rather than firing immediately with
    // whatever the action palette happened to be showing.
    fireEvent.click(await screen.findByRole('button', { name: /^revert$/i }));
    expect(api.revertModerationAction).not.toHaveBeenCalled();
    const dialog = await screen.findByText(/why is this action being undone/i);
    expect(dialog).toBeInTheDocument();
    // Choose a reversal reason DIFFERENT from the palette's default, and assert
    // that is what reaches the server: the server records this as the reason for
    // the reversal, so inheriting the palette's `MOD_HARASS_001` would write a
    // false justification into the action row and the audit trail.
    await userEvent.click(screen.getByRole('combobox', { name: /reversal reason/i }));
    await userEvent.click(screen.getByRole('option', { name: /MOD_SPAM_001/ }));
    fireEvent.click(screen.getByRole('button', { name: /^revert action$/i }));
    await waitFor(() =>
      expect(api.revertModerationAction).toHaveBeenCalledWith(ACTION_ID, 'MOD_SPAM_001'),
    );
    expect(await screen.findByText(/action reverted/i)).toBeInTheDocument();
  });

  it('WS-J.2.3b: an already-reverted action shows the badge and offers no second revert', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue({
      ...caseReview,
      user_history: {
        ...caseReview.user_history,
        past_actions: [
          {
            action_id: '00000000-0000-4000-8000-0000000000f3',
            action: 'warn',
            reason_code: null,
            created_at: NOW,
            reverted: true,
            reversible: true,
          },
        ],
      },
    });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    expect(await screen.findByText('Reverted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^revert$/i })).not.toBeInTheDocument();
  });

  it('WS-J.2.3b: a NON-reversible action offers no control that could only fail', async () => {
    // Bans, lawful-basis removals and the workflow verbs are recorded
    // `reversible: false`, and `revertAction` refuses them with
    // `not_reversible` — so a Revert button on them is a control whose only
    // outcome is an error toast.
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchCase).mockResolvedValue({
      ...caseReview,
      user_history: {
        ...caseReview.user_history,
        past_actions: [
          {
            action_id: '00000000-0000-4000-8000-0000000000f4',
            action: 'suspend',
            reason_code: 'MOD_HARASS_001',
            created_at: NOW,
            reverted: false,
            reversible: false,
          },
        ],
      },
    });
    render(<ModerationConsole />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole('button', { name: /MOD_HARASS_001/ }));
    expect(await screen.findByText('Not reversible')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^revert$/i })).not.toBeInTheDocument();
  });

  it('WS-J.2.1d: the control INITIALISES from the server, not a local default', async () => {
    // A fixed `available` default told a reviewer they were in the
    // auto-assignment pool while `availableIds()` still excluded them, and
    // opening the console did not correct it — the control stated the opposite
    // of the truth for as long as the reviewer believed it.
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchReviewerStatus).mockResolvedValue({ status: 'offline' });
    render(<ModerationConsole />, { wrapper: Providers });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /my availability/i })).toHaveTextContent(
        'offline',
      ),
    );
  });

  it('WS-J.2.1d: availability posts the chosen status', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchReviewerStatus).mockResolvedValue({ status: 'available' });
    vi.mocked(api.setReviewerStatus).mockResolvedValue({ ok: true });
    render(<ModerationConsole />, { wrapper: Providers });
    // The design-system Select is a listbox combobox, not a native <select>.
    await userEvent.click(await screen.findByRole('combobox', { name: /my availability/i }));
    await userEvent.click(screen.getByRole('option', { name: 'busy' }));
    await waitFor(() => expect(api.setReviewerStatus).toHaveBeenCalledWith('busy'));
    expect(screen.getByRole('combobox', { name: /my availability/i })).toHaveTextContent('busy');
  });

  it('WS-J.2.1d: a rejected availability change does not leave the control lying', async () => {
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchReviewerStatus).mockResolvedValue({ status: 'available' });
    vi.mocked(api.setReviewerStatus).mockRejectedValue(
      new ApiClientError('insufficient_capability', 'no', 403),
    );
    render(<ModerationConsole />, { wrapper: Providers });
    await userEvent.click(await screen.findByRole('combobox', { name: /my availability/i }));
    await userEvent.click(screen.getByRole('option', { name: 'offline' }));
    expect(await screen.findByText(/cannot set a reviewer status/i)).toBeInTheDocument();
    // Still showing what the server actually believes, not the failed choice —
    // this control is the only place a steward learns their own availability.
    expect(screen.getByRole('combobox', { name: /my availability/i })).toHaveTextContent(
      'available',
    );
  });

  it('WS-J.2.5: the audit tab exports the transparency report VERBATIM', async () => {
    savedBlobs.length = 0;
    const report = {
      generated_at: NOW,
      period_start: '2026-04-01T00:00:00.000Z',
      period_end: '2026-05-01T00:00:00.000Z',
      suppression_threshold: 5,
      by_action: [{ key: 'remove', count: 12, suppressed: false }],
      by_reason_code: [{ key: 'MOD_HARASS_001', count: null, suppressed: true }],
      by_severity: [{ key: 'moderate', count: 12, suppressed: false }],
      total: { key: 'total', count: 12, suppressed: false },
    };
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchAudit).mockResolvedValue(auditList);
    vi.mocked(api.exportAudit).mockResolvedValue(report);
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Audit log');
    fireEvent.click(await screen.findByRole('button', { name: /export transparency report/i }));
    await waitFor(() => expect(savedBlobs).toHaveLength(1));
    const saved = savedBlobs[0];
    if (!saved) throw new Error('no blob saved');
    // The suppression flag must survive to the published file — an export that
    // dropped it would publish a small cell as a plain absence.
    const parsed: unknown = JSON.parse(await saved.blob.text());
    expect(parsed).toEqual(report);
    expect(saved.filename).toBe('moderation-transparency-2026-04-01-to-2026-05-01.json');
  });

  it('WS-J.2.5: a forbidden export says so instead of downloading an empty file', async () => {
    savedBlobs.length = 0;
    vi.mocked(api.fetchReportQueue).mockResolvedValue(queueWithCase);
    vi.mocked(api.fetchAudit).mockResolvedValue(auditList);
    vi.mocked(api.exportAudit).mockRejectedValue(
      new ApiClientError('insufficient_capability', 'no', 403),
    );
    render(<ModerationConsole />, { wrapper: Providers });
    tab('Audit log');
    fireEvent.click(await screen.findByRole('button', { name: /export transparency report/i }));
    expect(await screen.findByText(/cannot export the audit log/i)).toBeInTheDocument();
    expect(savedBlobs).toHaveLength(0);
  });
});
