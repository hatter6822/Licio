// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2 moderation console (steward workspace): the priority/SLA-sorted report
// queue (emergency on top) + full-context review with the action palette
// (WS-J.2.1/2.2/2.3), the appeal review interface enforcing independence
// (WS-J.2.4), and the audit viewer (WS-J.2.5).  Authorization is enforced
// server-side; a non-steward simply sees an access notice.  No financial data
// appears on any surface.
import type {
  AppealQueueRow,
  AppealReviewResponse,
  CaseReviewResponse,
  ConsoleAction,
  EvidenceDecisionRequest,
  ModerationCaseRow,
  ModerationReasonCode,
} from '@licio/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider.js';
import { ApiClientError } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  applyEvidenceDecision,
  applyModerationAction,
  checkEvidenceUrl,
  decideAppeal,
  fetchAppeal,
  fetchAppealQueue,
  fetchAudit,
  fetchCase,
  fetchEvidenceDecisions,
  fetchEvidenceQueue,
  fetchIncidents,
  fetchReportQueue,
  resolveIncident,
} from '../../lib/safety-api.js';
import { REPORT_REASONS_BY_CODE } from '../safety/report-reasons.js';
import { Button } from '../ui/Button/index.js';
import { Dialog } from '../ui/Dialog/index.js';
import { Select } from '../ui/Select/index.js';
import { Tabs } from '../ui/Tabs/index.js';
import { TextArea } from '../ui/TextArea/index.js';
import { useToast } from '../ui/Toast/index.js';

const REASON_OPTIONS = [...REPORT_REASONS_BY_CODE.values()].map((r) => ({
  value: r.code,
  label: `${r.code} — ${r.label}`,
}));

/** Modify-decision target actions (the server enforces strict de-escalation; a
 *  non-de-escalating choice is rejected with 400). */
const MODIFY_ACTION_OPTIONS: ReadonlyArray<{ value: ConsoleAction; label: string }> = [
  { value: 'warn', label: 'warn' },
  { value: 'hide', label: 'hide' },
  { value: 'restrict', label: 'restrict' },
  { value: 'shadow', label: 'shadow' },
  { value: 'suspend', label: 'suspend' },
];

const slaTone: Record<string, string> = {
  ok: 'text-ink-muted',
  approaching: 'text-warning',
  breached: 'text-error font-semibold',
};

function isForbidden(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 403;
}

/**
 * WS-J.2.6b: a reporter-supplied evidence link resolves the SERVER-side
 * redirect-chain malware verdict before the reviewer navigates (evidence URLs
 * are stored, never fetched at submission time).  Until a verdict exists the
 * trigger is a BUTTON, not an anchor — an `href` would let middle-click,
 * context-menu "open in new tab", and other non-click activations bypass the
 * check entirely.  `malicious` replaces it with a blocked notice;
 * `unavailable` warns but leaves the reviewer in control ("open anyway" — the
 * reviewer IS the human-review path); `clear` surfaces a real
 * `rel="noreferrer noopener"` anchor rather than auto-opening: this is a
 * reporter-supplied destination, and `window.open` cannot withhold the
 * Referer (its `noreferrer` feature string would also null the SUCCESS
 * return, making popup blocking undetectable), so the deliberate second
 * click on the anchor is the referrer-safe navigation path.
 */
function EvidenceLink({ url }: { url: string }): React.ReactElement {
  const t = useT();
  const [state, setState] = useState<'idle' | 'checking' | 'clear' | 'malicious' | 'unavailable'>(
    'idle',
  );

  const activate = (): void => {
    if (state === 'checking') return;
    setState('checking');
    void checkEvidenceUrl(url)
      .then(({ verdict }) => setState(verdict))
      .catch(() => {
        // Fail toward flagging: an unreachable check warns, never silently opens.
        setState('unavailable');
      });
  };

  if (state === 'malicious') {
    return (
      <span role="status" className="font-semibold text-error">
        {t('console.evidenceMalicious', 'Blocked: this link resolves to a known malicious site.')}{' '}
        <span className="font-normal text-ink-muted line-through">{url}</span>
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="text-left text-primary underline"
        onClick={activate}
        title={t('console.evidenceCheckTitle', 'Checks this link for malware before opening')}
      >
        {url}
      </button>
      {state === 'checking' ? (
        <span role="status" className="ml-1 text-ink-muted">
          {t('console.evidenceChecking', 'checking link…')}
        </span>
      ) : null}
      {state === 'unavailable' ? (
        <span role="status" className="ml-1 text-warning">
          {t('console.evidenceUnverified', 'Could not verify this link.')}{' '}
          <a href={url} target="_blank" rel="noreferrer noopener" className="underline">
            {t('console.evidenceOpenAnyway', 'Open anyway')}
          </a>
        </span>
      ) : null}
      {state === 'clear' ? (
        <span role="status" className="ml-1 text-ink-muted">
          {t('console.evidenceVerified', 'Verified.')}{' '}
          <a href={url} target="_blank" rel="noreferrer noopener" className="underline">
            {t('console.evidenceOpen', 'Open link')}
          </a>
        </span>
      ) : null}
    </>
  );
}

export function ModerationConsole(): React.ReactElement {
  const t = useT();
  return (
    <section aria-labelledby="console-heading" className="flex flex-col gap-4">
      <h1 id="console-heading" className="text-2xl font-semibold text-ink">
        {t('console.title', 'Moderation console')}
      </h1>
      <Tabs
        label={t('console.tabs', 'Console sections')}
        tabs={[
          { id: 'queue', label: t('console.queue', 'Report queue') },
          { id: 'evidence', label: t('console.evidence', 'Evidence') },
          { id: 'appeals', label: t('console.appeals', 'Appeals') },
          { id: 'integrity', label: t('console.integrity', 'Integrity') },
          { id: 'audit', label: t('console.audit', 'Audit log') },
        ]}
      >
        {(activeId) => (
          <>
            {activeId === 'queue' ? <ReportQueuePanel /> : null}
            {activeId === 'evidence' ? <EvidencePanel /> : null}
            {activeId === 'appeals' ? <AppealsPanel /> : null}
            {activeId === 'integrity' ? <IncidentsPanel /> : null}
            {activeId === 'audit' ? <AuditPanel /> : null}
          </>
        )}
      </Tabs>
    </section>
  );
}

function AccessNotice(): React.ReactElement {
  const t = useT();
  return (
    <p className="rounded-md border border-line bg-canvas p-4 text-ink-muted">
      {t('console.forbidden', 'Your role does not have access to this part of the console.')}
    </p>
  );
}

function ReportQueuePanel(): React.ReactElement {
  const t = useT();
  const [openCase, setOpenCase] = useState<string | null>(null);
  const queue = useInfiniteQuery({
    queryKey: queryKeys.modQueue('default'),
    queryFn: ({ pageParam }) => fetchReportQueue(pageParam ? { cursor: pageParam } : {}),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
  if (queue.isError) return <AccessNotice />;
  const rows: ModerationCaseRow[] =
    queue.data?.pages.flatMap((p) => [...p.emergency, ...p.standard]) ?? [];
  return (
    <div className="flex flex-col gap-2">
      {queue.data && rows.length === 0 ? (
        <p className="text-ink-muted">{t('console.queueEmpty', 'The report queue is clear.')}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.case_id}>
            <button
              type="button"
              onClick={() => setOpenCase(row.case_id)}
              className="flex w-full items-center justify-between rounded-md border border-line bg-canvas p-3 text-start hover:bg-surface"
            >
              <span className="flex flex-col">
                <span className="font-medium text-ink">
                  {row.routed_to === 'emergency' ? '🚨 ' : ''}
                  {row.reason_codes.join(', ')}
                </span>
                <span className="text-xs text-ink-muted">
                  {t('console.severity', 'Severity')}: {row.severity} · {row.report_count}{' '}
                  {t('console.reports', 'reports')} · {row.status}
                </span>
              </span>
              <span className={`text-xs ${slaTone[row.sla_state] ?? 'text-ink-muted'}`}>
                {t('console.sla', 'SLA')}: {row.sla_state}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {queue.hasNextPage ? (
        <Button
          variant="ghost"
          loading={queue.isFetchingNextPage}
          onClick={() => void queue.fetchNextPage()}
          className="self-center"
        >
          {t('console.loadMore', 'Load more')}
        </Button>
      ) : null}
      {openCase ? <CaseReviewDialog caseId={openCase} onClose={() => setOpenCase(null)} /> : null}
    </div>
  );
}

function CaseReviewDialog({
  caseId,
  onClose,
}: {
  caseId: string;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const review = useQuery({
    queryKey: queryKeys.modCase(caseId),
    queryFn: () => fetchCase(caseId),
    retry: false,
  });
  const [action, setAction] = useState<ConsoleAction>('hide');
  const [reasonCode, setReasonCode] = useState<ModerationReasonCode>('MOD_HARASS_001');
  const data: CaseReviewResponse | undefined = review.data;
  // The palette only offers actions VALID for this case's target (server-scoped).
  // The initial `hide` may not be among them (a room case → clear/escalate, or a
  // role without hide), so default to the first available action until the
  // reviewer picks one — Apply then never submits an action that can only fail.
  const effectiveAction: ConsoleAction =
    data && !data.available_actions.includes(action)
      ? (data.available_actions[0] ?? action)
      : action;

  const apply = useMutation({
    mutationFn: () =>
      applyModerationAction({
        // Pass the case's REAL target type (content/account/room) — collapsing
        // room→content made a room case resolve the wrong target (or 400).  The
        // server allows only clear/escalate on a room target.
        targetType: data?.target_type ?? 'content',
        targetId: data?.target_id ?? '',
        action: effectiveAction,
        reasonCode,
        caseId,
      }),
    onSuccess: () => {
      toast({
        message: t('console.actionDone', 'Action applied and the case was resolved.'),
        tone: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.modQueue('default') });
      onClose();
    },
    onError: (e) =>
      toast({
        message: isForbidden(e)
          ? t('console.actionForbidden', 'Your role cannot take that action.')
          : t('console.actionFailed', 'The action could not be applied.'),
        tone: 'error',
      }),
  });

  return (
    <Dialog open onClose={onClose} title={t('console.reviewTitle', 'Review case')}>
      {review.isLoading ? (
        <p className="text-ink-muted">{t('common.loading', 'Loading…')}</p>
      ) : null}
      {data ? (
        <div className="flex flex-col gap-4">
          <section aria-label={t('console.reports', 'Reports')}>
            <h3 className="text-xs font-semibold uppercase text-ink-muted">
              {t('console.reports', 'Reports')}
            </h3>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {data.reports.map((r) => (
                <li key={r.report_id} className="rounded bg-surface p-2">
                  <span className="font-medium text-ink">{r.reason_code}</span>
                  {r.context ? <span className="text-ink-muted"> — {r.context}</span> : null}
                  {r.reporter_handle ? (
                    <span className="ml-1 text-xs text-ink-muted">({r.reporter_handle})</span>
                  ) : null}
                  {r.evidence_urls.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {r.evidence_urls.map((url) => (
                        <li key={url} className="truncate text-xs">
                          <span className="text-ink-muted">
                            {t('console.evidence', 'Evidence')}:{' '}
                          </span>
                          {/* Reporter-supplied links resolve the WS-J.2.6b
                              server-side malware verdict before navigation and
                              open with no referrer/opener leakage. */}
                          <EvidenceLink url={url} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <section aria-label={t('console.signals', 'Invariant signals')}>
            <h3 className="text-xs font-semibold uppercase text-ink-muted">
              {t('console.signals', 'Invariant signals')}
            </h3>
            <p className="text-xs text-ink-muted">{data.invariant_signals.disclaimer}</p>
            <ul className="mt-1 grid grid-cols-2 gap-1 text-xs">
              {(['mfci', 'scoi', 'phi', 'hodge'] as const).map((k) => (
                <li key={k} className="rounded bg-surface p-1">
                  {k.toUpperCase()}:{' '}
                  {data.invariant_signals[k].available
                    ? (data.invariant_signals[k].state ?? '—')
                    : t('console.signalUnavailable', 'unavailable')}
                </li>
              ))}
            </ul>
          </section>

          {/* The reported content + surrounding thread (WS-J.2.2a) — shown so a
              reviewer never decides blind, even when the item wasn't edited
              after the report (side_by_side null). Rendered as escaped text. */}
          {data.thread_context.length > 0 || data.snapshot_body ? (
            <section aria-label={t('console.reportedContent', 'Reported content')}>
              <h3 className="text-xs font-semibold uppercase text-ink-muted">
                {t('console.reportedContent', 'Reported content')}
              </h3>
              {/* The reported item's own body (a story's title/excerpt, or a
                  contribution's report-time body) shown ALONGSIDE the thread —
                  a story-level report (reported_contribution_id null) is not in
                  thread_context, so without this the steward never sees it. */}
              {data.snapshot_body ? (
                <pre className="mt-1 overflow-auto rounded bg-surface p-2 text-xs">
                  {data.snapshot_body}
                </pre>
              ) : null}
              {data.thread_context.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-1">
                  {data.thread_context.map((item) => {
                    const isReported = item.contribution_id === data.reported_contribution_id;
                    return (
                      <li
                        key={item.contribution_id}
                        className={`rounded p-2 text-sm ${isReported ? 'border-l-2 border-warning bg-surface pl-2' : 'bg-surface'}`}
                      >
                        <span className="text-xs text-ink-muted">
                          {item.author_handle ?? t('console.unknown', 'unknown')}
                          {isReported ? ` · ${t('console.reportedItem', 'reported')}` : ''}
                        </span>
                        <p className="whitespace-pre-wrap text-ink">
                          {item.body || t('console.noBody', '—')}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          ) : null}

          <section aria-label={t('console.history', 'User history')}>
            <h3 className="text-xs font-semibold uppercase text-ink-muted">
              {t('console.history', 'User history')}
            </h3>
            <p className="text-xs text-ink-muted">
              {t('console.accountAge', 'Account age (days)')}:{' '}
              {data.user_history.account_age_days ?? t('console.unknown', 'unknown')} ·{' '}
              {t('console.priorActions', 'prior actions')}: {data.user_history.past_actions.length}
            </p>
          </section>

          {data.side_by_side ? (
            <section aria-label={t('console.diff', 'Edited since report')} className="text-xs">
              <h3 className="text-xs font-semibold uppercase text-warning">
                {t('console.editedAfter', 'Edited after the report')}
              </h3>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <pre className="overflow-auto rounded bg-surface p-2 line-through">
                  {data.side_by_side.original_body}
                </pre>
                <pre className="overflow-auto rounded bg-surface p-2">
                  {data.side_by_side.current_body}
                </pre>
              </div>
            </section>
          ) : null}

          <section
            aria-label={t('console.palette', 'Action palette')}
            className="flex flex-col gap-2"
          >
            <h3 className="text-xs font-semibold uppercase text-ink-muted">
              {t('console.palette', 'Action palette')}
            </h3>
            <Select
              label={t('console.action', 'Action')}
              value={effectiveAction}
              onValueChange={(v) => setAction(v as ConsoleAction)}
              options={data.available_actions.map((a) => ({ value: a, label: a }))}
            />
            <Select
              label={t('console.reason', 'Reason code')}
              value={reasonCode}
              onValueChange={(v) => setReasonCode(v as ModerationReasonCode)}
              options={REASON_OPTIONS}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate()}>
                {t('console.apply', 'Apply action')}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}

/** STEWARD_ROLES.md ROLE_EVIDENCE: the FIFO queue of citation-bearing
 *  contributions (sourced comments + corrections) awaiting an evidence
 *  steward's review.  Decisions are evidence METADATA — never a content action
 *  (ROLE_EVIDENCE holds no removal power): `mark-primary-source` and
 *  `flag-citation` annotate ONE citation, `clear` marks the contribution
 *  reviewed with no annotation.  Every decision lands in the reviewable
 *  "Recent decisions" trail below the queue. */
function EvidencePanel(): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [flagTarget, setFlagTarget] = useState<{
    contributionId: string;
    citationUrl: string;
  } | null>(null);
  const queue = useInfiniteQuery({
    queryKey: queryKeys.modEvidenceQueue(),
    queryFn: ({ pageParam }) => fetchEvidenceQueue(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
  const decisions = useInfiniteQuery({
    queryKey: queryKeys.modEvidenceDecisions(),
    queryFn: ({ pageParam }) => fetchEvidenceDecisions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.modEvidenceQueue() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.modEvidenceDecisions() });
  };
  const decide = useMutation({
    mutationFn: (request: EvidenceDecisionRequest) => applyEvidenceDecision(request),
    onSuccess: () => {
      toast({
        message: t('console.evidenceDecided', 'Evidence decision recorded.'),
        tone: 'success',
      });
      refresh();
    },
    onError: (e) => {
      // A 409 means another steward already decided this contribution — the
      // row has left the queue; refresh rather than treating it as a failure.
      const duplicate = e instanceof ApiClientError && e.status === 409;
      toast({
        message: duplicate
          ? t(
              'console.evidenceDuplicate',
              'This contribution was already reviewed by another steward.',
            )
          : isForbidden(e)
            ? t('console.evidenceForbidden', 'Your role cannot record that decision.')
            : t('console.evidenceDecisionFailed', 'Could not record that decision.'),
        tone: duplicate ? 'info' : 'error',
      });
      if (duplicate) refresh();
    },
  });
  if (queue.isError) return <AccessNotice />;
  const rows = queue.data?.pages.flatMap((p) => p.items) ?? [];
  const decisionRows = decisions.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">
        {t(
          'console.evidenceHelp',
          'Evidence decisions annotate citations (primary source / flagged) or mark a contribution reviewed. They never remove content.',
        )}
      </p>
      {queue.data && rows.length === 0 ? (
        <p className="text-ink-muted">
          {t('console.evidenceQueueEmpty', 'The evidence queue is clear.')}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.contribution_id}
            className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="flex flex-col text-sm">
                <span className="font-medium text-ink">{row.story_title ?? row.thread_id}</span>
                <span className="text-xs text-ink-muted">{row.created_at.slice(0, 16)}</span>
              </span>
              <span className="shrink-0 rounded border border-line px-1.5 py-px text-xs text-ink-muted">
                {row.type === 'correction'
                  ? t('console.evidenceCorrection', 'correction')
                  : t('console.evidenceComment', 'comment')}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-ink">{row.body_preview}</p>
            <ul className="flex flex-col gap-2">
              {row.citations.map((citation) => (
                <li
                  key={citation.url}
                  className="flex flex-col gap-1 rounded bg-surface p-2 text-xs"
                >
                  <span className="truncate">
                    <span className="text-ink-muted">{t('console.citation', 'Citation')}: </span>
                    {/* Steward-facing citation links resolve the WS-J.2.6b
                        server-side malware verdict before navigation (the
                        url-verdict route accepts evidence stewards too). */}
                    <EvidenceLink url={citation.url} />
                  </span>
                  {citation.title ? <span className="text-ink-muted">{citation.title}</span> : null}
                  <span className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={decide.isPending}
                      onClick={() =>
                        decide.mutate({
                          contribution_id: row.contribution_id,
                          action: 'mark-primary-source',
                          citation_url: citation.url,
                        })
                      }
                    >
                      {t('console.markPrimary', 'Mark primary source')}
                    </Button>
                    <Button
                      variant="ghost"
                      aria-haspopup="dialog"
                      onClick={() =>
                        setFlagTarget({
                          contributionId: row.contribution_id,
                          citationUrl: citation.url,
                        })
                      }
                    >
                      {t('console.flagCitation', 'Flag citation')}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button
                variant="ghost"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ contribution_id: row.contribution_id, action: 'clear' })
                }
              >
                {t('console.markReviewed', 'Mark reviewed')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {queue.hasNextPage ? (
        <Button
          variant="ghost"
          loading={queue.isFetchingNextPage}
          onClick={() => void queue.fetchNextPage()}
          className="self-center"
        >
          {t('console.loadMore', 'Load more')}
        </Button>
      ) : null}

      <section
        aria-label={t('console.recentDecisions', 'Recent decisions')}
        className="flex flex-col gap-1"
      >
        <h3 className="text-xs font-semibold uppercase text-ink-muted">
          {t('console.recentDecisions', 'Recent decisions')}
        </h3>
        <ul className="flex flex-col gap-1 text-sm">
          {decisionRows.map((d) => (
            <li key={d.decision_id} className="rounded bg-surface p-2">
              <span className="font-medium text-ink">{d.action}</span>
              {d.citation_url ? (
                <span className="break-all text-ink-muted"> · {d.citation_url}</span>
              ) : null}
              {d.reason_code ? <span className="text-ink-muted"> · {d.reason_code}</span> : null}
              <span className="text-ink-muted">
                {' '}
                · {d.decided_by_handle ?? t('console.system', 'system')} ·{' '}
                {d.created_at.slice(0, 16)}
              </span>
              {d.note ? (
                <p className="mt-0.5 text-xs text-ink-muted">
                  {t('console.decisionNote', 'Note')}: {d.note}
                </p>
              ) : null}
            </li>
          ))}
          {decisions.data && decisionRows.length === 0 ? (
            <li className="text-ink-muted">
              {t('console.noDecisions', 'No evidence decisions yet.')}
            </li>
          ) : null}
        </ul>
        {decisions.hasNextPage ? (
          <Button
            variant="ghost"
            loading={decisions.isFetchingNextPage}
            onClick={() => void decisions.fetchNextPage()}
            className="self-center"
          >
            {t('console.loadMore', 'Load more')}
          </Button>
        ) : null}
      </section>

      {flagTarget ? (
        <FlagCitationDialog
          citationUrl={flagTarget.citationUrl}
          pending={decide.isPending}
          onSubmit={(reasonCode, note) => {
            const trimmed = note.trim();
            decide.mutate(
              {
                contribution_id: flagTarget.contributionId,
                action: 'flag-citation',
                citation_url: flagTarget.citationUrl,
                reason_code: reasonCode,
                ...(trimmed ? { note: trimmed } : {}),
              },
              { onSettled: () => setFlagTarget(null) },
            );
          }}
          onClose={() => setFlagTarget(null)}
        />
      ) : null}
    </div>
  );
}

/** Flagging a citation requires a ratified WS-A reason code (a flag without a
 *  reason is not reviewable) — the Flag button stays disabled until one is
 *  chosen.  The note is an internal reviewer note, never shown to the author. */
function FlagCitationDialog({
  citationUrl,
  pending,
  onSubmit,
  onClose,
}: {
  citationUrl: string;
  pending: boolean;
  onSubmit: (reasonCode: ModerationReasonCode, note: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  // Empty until the steward picks — flagging REQUIRES an explicit reason.
  const [reasonCode, setReasonCode] = useState<ModerationReasonCode | ''>('');
  const [note, setNote] = useState('');
  return (
    <Dialog open onClose={onClose} title={t('console.flagCitationTitle', 'Flag citation')}>
      <div className="flex flex-col gap-3">
        <p className="break-all text-xs text-ink-muted">{citationUrl}</p>
        <Select
          label={t('console.reason', 'Reason code')}
          value={reasonCode}
          onValueChange={(v) => setReasonCode(v as ModerationReasonCode)}
          options={REASON_OPTIONS}
          placeholder={t('console.pickReason', 'Select a reason')}
          required
        />
        <TextArea
          label={t('console.flagNote', 'Internal note (optional)')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          rows={3}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={reasonCode === ''}
            onClick={() => {
              if (reasonCode !== '') onSubmit(reasonCode, note);
            }}
          >
            {t('console.flagSubmit', 'Flag')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AppealsPanel(): React.ReactElement {
  const t = useT();
  const [reviewFor, setReviewFor] = useState<AppealQueueRow | null>(null);
  const appeals = useInfiniteQuery({
    queryKey: queryKeys.modAppeals(),
    queryFn: ({ pageParam }) => fetchAppealQueue(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
  if (appeals.isError) return <AccessNotice />;
  const items = appeals.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="flex flex-col gap-2">
      {appeals.data && items.length === 0 ? (
        <p className="text-ink-muted">{t('console.appealsEmpty', 'No appeals are pending.')}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {items.map((a) => (
          <li
            key={a.appeal_id}
            className="flex items-center justify-between rounded-md border border-line bg-canvas p-3"
          >
            <span className="flex flex-col text-sm">
              <span className="font-medium text-ink">
                {a.original_action}{' '}
                {a.is_ban_appeal ? `(${t('console.banAppeal', 'ban appeal')})` : ''}
              </span>
              <span className={`text-xs ${slaTone[a.sla_state] ?? 'text-ink-muted'}`}>
                SLA: {a.sla_state}
              </span>
            </span>
            {/* No inline decide here: the decision is made from the review dialog,
                which loads the appellant statement, new evidence, original
                context, and side-by-side snapshot — a reviewer must not decide
                blind from the queue row (WS-J.2.4). */}
            <Button variant="secondary" onClick={() => setReviewFor(a)}>
              {t('console.reviewAppeal', 'Review')}
            </Button>
          </li>
        ))}
      </ul>
      {appeals.hasNextPage ? (
        <Button
          variant="ghost"
          loading={appeals.isFetchingNextPage}
          onClick={() => void appeals.fetchNextPage()}
          className="self-center"
        >
          {t('console.loadMore', 'Load more')}
        </Button>
      ) : null}
      {reviewFor ? (
        <AppealReviewDialog appeal={reviewFor} onClose={() => setReviewFor(null)} />
      ) : null}
    </div>
  );
}

/** The independence-preserving appeal review (WS-J.2.4): loads the full review
 *  payload — appellant statement, new evidence, original action + reviewer,
 *  report-time snapshot, side-by-side edit diff, user history — and only then
 *  offers a decision, each requiring a written explanation sent to the user. */
function AppealReviewDialog({
  appeal,
  onClose,
}: {
  appeal: AppealQueueRow;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const review = useQuery({
    queryKey: queryKeys.modAppeal(appeal.appeal_id),
    queryFn: () => fetchAppeal(appeal.appeal_id),
    retry: false,
  });
  const [reasonCode, setReasonCode] = useState<ModerationReasonCode>(
    appeal.original_reason_code ?? 'MOD_HARASS_001',
  );
  const [explanation, setExplanation] = useState('');
  const [modifiedAction, setModifiedAction] = useState<ConsoleAction>('warn');
  const data: AppealReviewResponse | undefined = review.data;

  const decide = useMutation({
    mutationFn: (decision: 'overturn' | 'uphold' | 'modify') =>
      decideAppeal(appeal.appeal_id, {
        decision,
        reason_code: reasonCode,
        explanation: explanation.trim(),
        ...(decision === 'modify' ? { modified_action: modifiedAction } : {}),
      }),
    onSuccess: () => {
      toast({
        message: t('console.appealDecided', 'Appeal decided and the user was notified.'),
        tone: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.modAppeals() });
      onClose();
    },
    onError: (e) =>
      toast({
        message: isForbidden(e)
          ? t('console.appealForbidden', 'Your role cannot decide this appeal.')
          : t('console.appealFailed', 'Could not record that decision.'),
        tone: 'error',
      }),
  });
  const canDecide = explanation.trim().length > 0 && !decide.isPending;

  return (
    <Dialog open onClose={onClose} title={t('console.appealReviewTitle', 'Review appeal')}>
      {review.isLoading ? (
        <p className="text-ink-muted">{t('common.loading', 'Loading…')}</p>
      ) : null}
      {review.isError ? (
        <p className="text-error">
          {t('console.appealReviewError', 'Could not load this appeal for review.')}
        </p>
      ) : null}
      {data ? (
        <div className="flex flex-col gap-4">
          <section aria-label={t('console.appealOriginal', 'Original action')}>
            <h3 className="text-xs font-semibold uppercase text-ink-muted">
              {t('console.appealOriginal', 'Original action')}
            </h3>
            <p className="text-sm text-ink">
              {data.original_action}
              {data.original_reason_code ? ` · ${data.original_reason_code}` : ''}
            </p>
            <p className="text-xs text-ink-muted">
              {t('console.appealDecidedBy', 'Decided by')}:{' '}
              {data.original_reviewer_handle ?? t('console.unknown', 'unknown')}
            </p>
          </section>

          <section aria-label={t('console.appellantStatement', 'Appellant statement')}>
            <h3 className="text-xs font-semibold uppercase text-ink-muted">
              {t('console.appellantStatement', 'Appellant statement')}
            </h3>
            <p className="whitespace-pre-wrap text-sm text-ink-muted">
              {data.appellant_statement || t('console.noStatement', 'No statement provided.')}
            </p>
          </section>

          {data.new_evidence.length > 0 ? (
            <section aria-label={t('console.newEvidence', 'New evidence')}>
              <h3 className="text-xs font-semibold uppercase text-ink-muted">
                {t('console.newEvidence', 'New evidence')}
              </h3>
              <ul className="mt-1 flex flex-col gap-1 text-xs text-ink-muted">
                {data.new_evidence.map((e) => (
                  <li key={e} className="truncate">
                    {e}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {data.snapshot_body ? (
            <section aria-label={t('console.reportedContent', 'Reported content')}>
              <h3 className="text-xs font-semibold uppercase text-ink-muted">
                {t('console.reportedContent', 'Reported content')}
              </h3>
              <pre className="overflow-auto rounded bg-surface p-2 text-xs">
                {data.snapshot_body}
              </pre>
            </section>
          ) : null}

          {data.side_by_side ? (
            <section aria-label={t('console.diff', 'Edited since report')} className="text-xs">
              <h3 className="text-xs font-semibold uppercase text-warning">
                {t('console.editedAfter', 'Edited after the report')}
              </h3>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <pre className="overflow-auto rounded bg-surface p-2 line-through">
                  {data.side_by_side.original_body}
                </pre>
                <pre className="overflow-auto rounded bg-surface p-2">
                  {data.side_by_side.current_body}
                </pre>
              </div>
            </section>
          ) : null}

          <section aria-label={t('console.history', 'User history')}>
            <p className="text-xs text-ink-muted">
              {t('console.accountAge', 'Account age (days)')}:{' '}
              {data.user_history.account_age_days ?? t('console.unknown', 'unknown')} ·{' '}
              {t('console.priorActions', 'prior actions')}: {data.user_history.past_actions.length}
            </p>
          </section>

          <section aria-label={t('console.decision', 'Decision')} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase text-ink-muted">
              {t('console.decision', 'Decision')}
            </h3>
            <Select
              label={t('console.reason', 'Reason code')}
              value={reasonCode}
              onValueChange={(v) => setReasonCode(v as ModerationReasonCode)}
              options={REASON_OPTIONS}
            />
            <Select
              label={t('console.modifyTo', 'Modified action (for Modify)')}
              value={modifiedAction}
              onValueChange={(v) => setModifiedAction(v as ConsoleAction)}
              options={MODIFY_ACTION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <TextArea
              label={t('console.appealExplanation', 'Explanation to the user')}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              maxLength={2000}
              rows={4}
              required
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="secondary"
                disabled={!canDecide}
                onClick={() => decide.mutate('uphold')}
              >
                {t('console.uphold', 'Uphold')}
              </Button>
              <Button
                variant="secondary"
                disabled={!canDecide}
                onClick={() => decide.mutate('modify')}
              >
                {t('console.modify', 'Modify')}
              </Button>
              <Button
                variant="primary"
                loading={decide.isPending}
                disabled={!canDecide}
                onClick={() => decide.mutate('overturn')}
              >
                {t('console.overturn', 'Overturn')}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}

/** WS-J.2.6e integrity queue: ROLE_INTEGRITY analysts clear (reports legitimate)
 *  or confirm (a coordinated false-report attack) a coordinated-report incident.
 *  Clearing lifts the case's enforcement delay; confirming dismisses the case
 *  (the target is protected).  Per-reporter identity never appears — the summary
 *  is aggregate, base-rate-conditioned. */
function IncidentsPanel(): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const incidents = useInfiniteQuery({
    queryKey: queryKeys.modIncidents(),
    queryFn: ({ pageParam }) => fetchIncidents(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
  const resolve = useMutation({
    mutationFn: (input: { incidentId: string; resolution: 'cleared' | 'confirmed' }) =>
      resolveIncident(input.incidentId, input.resolution),
    onSuccess: () => {
      toast({ message: t('console.incidentResolved', 'Incident resolved.'), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.modIncidents() });
    },
    onError: () =>
      toast({
        message: t('console.incidentFailed', 'Could not resolve that incident.'),
        tone: 'error',
      }),
  });
  if (incidents.isError) return <AccessNotice />;
  const items = incidents.data?.pages.flatMap((p) => p.incidents) ?? [];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-muted">
        {t(
          'console.integrityHelp',
          'Coordinated-report incidents delay volume-driven enforcement pending review. Clear (reports legitimate) to resume enforcement, or confirm (a coordinated attack) to dismiss the case.',
        )}
      </p>
      {incidents.data && items.length === 0 ? (
        <p className="text-ink-muted">
          {t('console.incidentsEmpty', 'No coordinated-report incidents are open.')}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {items.map((inc) => (
          <li
            key={inc.incident_id}
            className="flex items-start justify-between gap-3 rounded-md border border-line bg-canvas p-3"
          >
            <span className="flex flex-col text-sm">
              <span className="font-medium text-ink">
                {inc.report_count} {t('console.reportsIn', 'reports in')}{' '}
                {Math.round(inc.window_seconds / 60)}m · {inc.severity}
              </span>
              <span className="text-xs text-ink-muted">{inc.summary}</span>
              <span className="text-xs text-ink-muted">
                {t('console.coordinationScore', 'Coordination score')}:{' '}
                {inc.coordination_score.toFixed(2)}
              </span>
            </span>
            <span className="flex shrink-0 gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  resolve.mutate({ incidentId: inc.incident_id, resolution: 'cleared' })
                }
              >
                {t('console.clearIncident', 'Clear')}
              </Button>
              <Button
                variant="primary"
                onClick={() =>
                  resolve.mutate({ incidentId: inc.incident_id, resolution: 'confirmed' })
                }
              >
                {t('console.confirmIncident', 'Confirm')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {incidents.hasNextPage ? (
        <Button
          variant="ghost"
          loading={incidents.isFetchingNextPage}
          onClick={() => void incidents.fetchNextPage()}
          className="self-center"
        >
          {t('console.loadMore', 'Load more')}
        </Button>
      ) : null}
    </div>
  );
}

function AuditPanel(): React.ReactElement {
  const t = useT();
  const audit = useInfiniteQuery({
    queryKey: queryKeys.modAudit('default'),
    queryFn: ({ pageParam }) => fetchAudit(pageParam ? { cursor: pageParam } : {}),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
  if (audit.isError) return <AccessNotice />;
  const items = audit.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {items.map((entry) => (
        <li key={entry.audit_id} className="rounded bg-surface p-2">
          <span className="font-medium text-ink">{entry.action}</span>
          {entry.reason_code ? (
            <span className="text-ink-muted"> · {entry.reason_code}</span>
          ) : null}
          <span className="text-ink-muted">
            {' '}
            · {entry.actor_handle ?? t('console.system', 'system')} ·{' '}
            {entry.event_time.slice(0, 16)}
          </span>
        </li>
      ))}
      {audit.data && items.length === 0 ? (
        <li className="text-ink-muted">{t('console.auditEmpty', 'No audit records yet.')}</li>
      ) : null}
      {audit.hasNextPage ? (
        <li className="self-center">
          <Button
            variant="ghost"
            loading={audit.isFetchingNextPage}
            onClick={() => void audit.fetchNextPage()}
          >
            {t('console.loadMore', 'Load more')}
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
