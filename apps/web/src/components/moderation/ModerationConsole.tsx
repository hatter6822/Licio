// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2 moderation console (steward workspace): the priority/SLA-sorted report
// queue (emergency on top) + full-context review with the action palette
// (WS-J.2.1/2.2/2.3), the appeal review interface enforcing independence
// (WS-J.2.4), and the audit viewer (WS-J.2.5).  Authorization is enforced
// server-side; a non-steward simply sees an access notice.  No financial data
// appears on any surface.
import type {
  CaseReviewResponse,
  ConsoleAction,
  ModerationCaseRow,
  ModerationReasonCode,
} from '@licio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider.js';
import { ApiClientError } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  applyModerationAction,
  decideAppeal,
  fetchAppealQueue,
  fetchAudit,
  fetchCase,
  fetchIncidents,
  fetchReportQueue,
  resolveIncident,
} from '../../lib/safety-api.js';
import { REPORT_REASONS_BY_CODE } from '../safety/report-reasons.js';
import { Button } from '../ui/Button/index.js';
import { Dialog } from '../ui/Dialog/index.js';
import { Select } from '../ui/Select/index.js';
import { Tabs } from '../ui/Tabs/index.js';
import { useToast } from '../ui/Toast/index.js';

const REASON_OPTIONS = [...REPORT_REASONS_BY_CODE.values()].map((r) => ({
  value: r.code,
  label: `${r.code} — ${r.label}`,
}));

const slaTone: Record<string, string> = {
  ok: 'text-ink-muted',
  approaching: 'text-warning',
  breached: 'text-error font-semibold',
};

function isForbidden(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 403;
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
          { id: 'appeals', label: t('console.appeals', 'Appeals') },
          { id: 'integrity', label: t('console.integrity', 'Integrity') },
          { id: 'audit', label: t('console.audit', 'Audit log') },
        ]}
      >
        {(activeId) => (
          <>
            {activeId === 'queue' ? <ReportQueuePanel /> : null}
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
  const queue = useQuery({
    queryKey: queryKeys.modQueue('default'),
    queryFn: () => fetchReportQueue(),
    retry: false,
  });
  if (queue.isError) return isForbidden(queue.error) ? <AccessNotice /> : <AccessNotice />;
  const rows: ModerationCaseRow[] = [
    ...(queue.data?.emergency ?? []),
    ...(queue.data?.standard ?? []),
  ];
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

  const apply = useMutation({
    mutationFn: () =>
      applyModerationAction({
        targetType: data?.target_type === 'account' ? 'account' : 'content',
        targetId: data?.target_id ?? '',
        action,
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
              value={action}
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

function AppealsPanel(): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const appeals = useQuery({
    queryKey: queryKeys.modAppeals(),
    queryFn: fetchAppealQueue,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (input: { appealId: string; decision: 'overturn' | 'uphold' | 'modify' }) =>
      decideAppeal(input.appealId, {
        decision: input.decision,
        reason_code: 'MOD_HARASS_001',
        explanation:
          input.decision === 'overturn'
            ? 'Reviewed independently; the original action is reversed.'
            : 'Reviewed independently; the original action stands.',
      }),
    onSuccess: () => {
      toast({
        message: t('console.appealDecided', 'Appeal decided and the user was notified.'),
        tone: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.modAppeals() });
    },
    onError: () =>
      toast({
        message: t('console.appealFailed', 'Could not record that decision.'),
        tone: 'error',
      }),
  });
  if (appeals.isError) return <AccessNotice />;
  return (
    <div className="flex flex-col gap-2">
      {appeals.data && appeals.data.items.length === 0 ? (
        <p className="text-ink-muted">{t('console.appealsEmpty', 'No appeals are pending.')}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {appeals.data?.items.map((a) => (
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
            <span className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => decide.mutate({ appealId: a.appeal_id, decision: 'overturn' })}
              >
                {t('console.overturn', 'Overturn')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => decide.mutate({ appealId: a.appeal_id, decision: 'uphold' })}
              >
                {t('console.uphold', 'Uphold')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
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
  const incidents = useQuery({
    queryKey: queryKeys.modIncidents(),
    queryFn: fetchIncidents,
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
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-muted">
        {t(
          'console.integrityHelp',
          'Coordinated-report incidents delay volume-driven enforcement pending review. Clear (reports legitimate) to resume enforcement, or confirm (a coordinated attack) to dismiss the case.',
        )}
      </p>
      {incidents.data && incidents.data.incidents.length === 0 ? (
        <p className="text-ink-muted">
          {t('console.incidentsEmpty', 'No coordinated-report incidents are open.')}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {incidents.data?.incidents.map((inc) => (
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
    </div>
  );
}

function AuditPanel(): React.ReactElement {
  const t = useT();
  const audit = useQuery({
    queryKey: queryKeys.modAudit('default'),
    queryFn: () => fetchAudit({}),
    retry: false,
  });
  if (audit.isError) return <AccessNotice />;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {audit.data?.items.map((entry) => (
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
      {audit.data && audit.data.items.length === 0 ? (
        <li className="text-ink-muted">{t('console.auditEmpty', 'No audit records yet.')}</li>
      ) : null}
    </ul>
  );
}
