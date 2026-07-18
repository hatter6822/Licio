// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.1c / WS-N.2.2c — the compliance console (the moderation-console
// pattern): the case queue with the guarded review state machine, the fraud
// queue (flagged intents + fraud-class cases) with release/reject + SLA due
// times, and the WS-N.1.1f declaration-verification form.  Authorization is
// SERVER-side (compliance role + active MFA); a non-reviewer sees an access
// notice, never data.  Everything shown is transaction-derived only
// (WS-N.2.2d) — this surface structurally cannot render attention data
// because no API it calls carries any.  Reads go through TanStack Query (the
// zod-validated client flows are the queryFns), so actions invalidate rather
// than hand-refetch; each case card carries EXACTLY the controls its
// review_state permits, scoped to that case.  The page header (title + back
// button) belongs to the route page; the active tab is optionally controlled
// so it can live in `?tab=`.
import type {
  CaseResolutionOutcome,
  FinancialComplianceCase,
  FraudQueueResponse,
} from '@licio/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import {
  adminAssignCase,
  adminCaseAction,
  adminFetchFraudQueue,
  adminListCases,
  adminResolveCase,
  adminReviewIntent,
  adminVerifyDeclaration,
} from '../../lib/compliance-api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { Button } from '../ui/Button/index.js';
import { Card } from '../ui/Card/index.js';
import { Input } from '../ui/Input/index.js';
import { Select } from '../ui/Select/index.js';
import { Tabs } from '../ui/Tabs/index.js';

/** The outcomes a reviewer records when RESOLVING an investigating case (WS-N.2.1
 *  §22.6).  `escalated` is a state transition, not a resolution — it has its own
 *  control — so it is excluded here.  A hard-coded `cleared` would force a reviewer
 *  to falsely clear a scam/sanctions hold they mean to keep restricted. */
const RESOLVE_OUTCOMES: readonly CaseResolutionOutcome[] = [
  'cleared',
  'restricted',
  'account_suspended',
  'referred_to_law_enforcement',
];

/** Default English labels for the resolution outcomes (localizable). */
const OUTCOME_LABEL: Record<CaseResolutionOutcome, string> = {
  cleared: 'Cleared',
  restricted: 'Restricted',
  account_suspended: 'Account suspended',
  referred_to_law_enforcement: 'Referred to law enforcement',
  escalated: 'Escalated',
};

/** The console's tab ids — also the `?tab=` deep-link vocabulary (WS-C.1.1b). */
export type ComplianceConsoleTab = 'cases' | 'fraud' | 'declarations';

export interface ComplianceConsoleProps {
  /** Controlled active tab (the page syncs it to `?tab=`); omit for local state. */
  tab?: ComplianceConsoleTab;
  onTabChange?: (tab: ComplianceConsoleTab) => void;
}

/** 401/403 mean "not a reviewer" — anything else is an outage, and showing the
 *  access notice for it would misinform an authorized reviewer. */
function isAuthError(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 401 || error.status === 403);
}

export function ComplianceConsole({
  tab,
  onTabChange,
}: ComplianceConsoleProps = {}): React.JSX.Element {
  const t = useT();
  const cases = useQuery({
    queryKey: queryKeys.complianceCases(),
    queryFn: adminListCases,
    retry: false,
  });
  const fraud = useQuery({
    queryKey: queryKeys.complianceFraudQueue(),
    queryFn: adminFetchFraudQueue,
    retry: false,
  });

  if (isAuthError(cases.error) || isAuthError(fraud.error)) {
    return (
      <Card as="section">
        <h2 className="text-base font-semibold">
          {t('compliance.console.denied.title', 'Compliance access required')}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          {t(
            'compliance.console.denied.body',
            'This workspace is restricted to the financial-compliance team and platform administrators (active MFA required — the steward role deliberately does not grant it).',
          )}
        </p>
      </Card>
    );
  }

  if (cases.isError || fraud.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-error-fg">
          {t('compliance.console.load_error', 'Could not load the compliance queues.')}
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            void cases.refetch();
            void fraud.refetch();
          }}
        >
          {t('common.retry', 'Try again')}
        </Button>
      </div>
    );
  }

  return (
    <section aria-label={t('compliance.console.title', 'Compliance console')}>
      <Tabs
        label={t('compliance.console.title', 'Compliance console')}
        {...(tab !== undefined ? { value: tab } : {})}
        {...(onTabChange !== undefined
          ? { onValueChange: (id: string) => onTabChange(id as ComplianceConsoleTab) }
          : {})}
        tabs={[
          { id: 'cases', label: t('compliance.console.cases', 'Cases') },
          { id: 'fraud', label: t('compliance.console.fraud', 'Fraud queue') },
          { id: 'declarations', label: t('compliance.console.declarations', 'Declarations') },
        ]}
      >
        {(activeId) =>
          activeId === 'cases' ? (
            <CaseQueue cases={cases.data?.cases ?? null} />
          ) : activeId === 'fraud' ? (
            <FraudQueue items={fraud.data?.items ?? null} />
          ) : (
            <DeclarationVerification />
          )
        }
      </Tabs>
    </section>
  );
}

function CaseQueue({ cases }: { cases: FinancialComplianceCase[] | null }): React.JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  if (cases === null) {
    return <p className="text-sm text-ink-muted">{t('compliance.console.loading', 'Loading…')}</p>;
  }
  if (cases.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid="empty-cases">
        {t('compliance.console.noCases', 'No open compliance cases.')}
      </p>
    );
  }
  // One guarded action at a time; success invalidates both queues (a case action
  // can change fraud-queue rows too), failure surfaces per-action without
  // dropping the queue.
  const act = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.complianceCases() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.complianceFraudQueue() });
    } catch (e) {
      setError(
        e instanceof ApiClientError
          ? e.message
          : t('compliance.console.actionFailed', 'Action failed'),
      );
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {error !== null ? (
        <p role="alert" className="text-sm text-error-fg">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {cases.map((record) => (
          <li key={record.case_id}>
            <CaseCard record={record} act={act} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One case card exposing EXACTLY the transitions the server-side state machine
 *  permits for its review_state — with the inputs those transitions need scoped
 *  to THIS case (a shared cross-case input made it ambiguous which case an
 *  assignee or note was about to hit). */
function CaseCard({
  record,
  act,
}: {
  record: FinancialComplianceCase;
  act: (run: () => Promise<unknown>) => Promise<void>;
}): React.JSX.Element {
  const t = useT();
  const [assignee, setAssignee] = useState('');
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState<CaseResolutionOutcome>('cleared');
  return (
    <Card as="article">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {record.trigger_type} · {record.risk_level} · {record.review_state}
          </p>
          <p className="text-xs text-ink-muted">
            {t('compliance.console.opened', 'Opened {at}', {
              at: new Date(record.created_at).toLocaleString(),
            })}
          </p>
        </div>
        {record.review_state === 'open' ? (
          <div className="flex flex-wrap items-end gap-2">
            <Input
              label={t('compliance.console.assignee', 'Assignee user id')}
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
            />
            <Button
              disabled={assignee.trim() === ''}
              onClick={() => void act(() => adminAssignCase(record.case_id, assignee.trim()))}
            >
              {t('compliance.console.assign', 'Assign')}
            </Button>
          </div>
        ) : null}
        {record.review_state === 'assigned' || record.review_state === 'escalated' ? (
          <Button onClick={() => void act(() => adminCaseAction(record.case_id, 'begin'))}>
            {t('compliance.console.begin', 'Begin investigation')}
          </Button>
        ) : null}
        {record.review_state === 'investigating' ? (
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label={t('compliance.console.outcome', 'Resolution outcome')}
              value={outcome}
              onValueChange={(value) => setOutcome(value as CaseResolutionOutcome)}
              options={RESOLVE_OUTCOMES.map((candidate) => ({
                value: candidate,
                label: t(`compliance.console.outcome.${candidate}`, OUTCOME_LABEL[candidate]),
              }))}
            />
            <Input
              label={t('compliance.console.notes', 'Resolution notes')}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
            <Button
              disabled={notes.trim() === ''}
              onClick={() =>
                void act(() => adminResolveCase(record.case_id, outcome, notes.trim()))
              }
            >
              {t('compliance.console.resolve', 'Resolve: {outcome}', {
                outcome: t(`compliance.console.outcome.${outcome}`, OUTCOME_LABEL[outcome]),
              })}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void act(() => adminCaseAction(record.case_id, 'escalate'))}
            >
              {t('compliance.console.escalate', 'Escalate')}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function FraudQueue({ items }: { items: FraudQueueResponse['items'] | null }): React.JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  if (items === null) {
    return <p className="text-sm text-ink-muted">{t('compliance.console.loading', 'Loading…')}</p>;
  }
  if (items.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid="empty-fraud">
        {t('compliance.console.noFraud', 'Nothing awaiting fraud review.')}
      </p>
    );
  }
  const held = items.filter((item) => item.payment_intent_id !== null);
  const review = async (decision: 'release' | 'reject', paymentIntentId: string): Promise<void> => {
    try {
      await adminReviewIntent(decision, paymentIntentId, `console ${decision}`);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.complianceFraudQueue() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.complianceCases() });
    } catch (e) {
      setError(
        e instanceof ApiClientError
          ? e.message
          : t('compliance.console.reviewFailed', 'Review failed'),
      );
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {error !== null ? (
        <p role="alert" className="text-sm text-error-fg">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-ink-muted">
        {t(
          'compliance.console.fraudHint',
          '{held} held payment(s); SLA targets shown per row. Risk signals are transaction-derived only.',
          { held: held.length },
        )}
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((item, index) => {
          // Narrow once so the action closures carry a plain string (no cast).
          const intentId = item.payment_intent_id;
          return (
            <li key={`${item.case.case_id}:${intentId ?? index}`}>
              <Card as="article">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {item.case.trigger_type} · {item.case.risk_level}
                      {item.payment_compliance_state !== null
                        ? ` · ${item.payment_compliance_state}`
                        : ''}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {t('compliance.console.slaDue', 'SLA due {at}', {
                        at: new Date(item.sla_due_at).toLocaleString(),
                      })}
                    </p>
                  </div>
                  {intentId !== null && item.payment_compliance_state === 'flagged' ? (
                    <div className="flex gap-2">
                      <Button onClick={() => void review('release', intentId)}>
                        {t('compliance.console.release', 'Release')}
                      </Button>
                      <Button variant="secondary" onClick={() => void review('reject', intentId)}>
                        {t('compliance.console.reject', 'Reject')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DeclarationVerification(): React.JSX.Element {
  const t = useT();
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);
  const submit = async (decision: 'verify' | 'reject' | 'revoke'): Promise<void> => {
    try {
      await adminVerifyDeclaration(userId.trim(), decision, note.trim() || 'console review');
      setOutcome(
        decision === 'verify'
          ? t('compliance.console.verified', 'Declaration verified.')
          : decision === 'revoke'
            ? t(
                'compliance.console.revoked',
                'Verified region revoked; the member may now redeclare.',
              )
            : t('compliance.console.rejected', 'Declaration rejected (stays pending).'),
      );
    } catch (e) {
      setOutcome(
        e instanceof ApiClientError
          ? e.message
          : t('compliance.console.verifyFailed', 'Verification failed'),
      );
    }
  };
  return (
    <Card as="section">
      <h3 className="text-sm font-semibold">
        {t('compliance.console.verifyTitle', 'Verify a region declaration (WS-N.1.1f)')}
      </h3>
      <p className="mt-1 text-sm text-ink-muted">
        {t(
          'compliance.console.verifyHint',
          'Review the referenced evidence before verifying: with no geolocation anywhere on the platform, this verification is the only anti-circumvention control for real-fund jurisdictions.',
        )}
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Input
          label={t('compliance.console.userId', 'User id')}
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
        />
        <Input
          label={t('compliance.console.note', 'Review note')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button disabled={userId.trim() === ''} onClick={() => void submit('verify')}>
          {t('compliance.console.verify', 'Verify')}
        </Button>
        <Button
          variant="secondary"
          disabled={userId.trim() === ''}
          onClick={() => void submit('reject')}
        >
          {t('compliance.console.rejectDecl', 'Reject')}
        </Button>
        <Button
          variant="secondary"
          disabled={userId.trim() === ''}
          onClick={() => void submit('revoke')}
        >
          {t('compliance.console.revokeDecl', 'Revoke verified')}
        </Button>
      </div>
      {outcome !== null ? (
        <p role="status" className="mt-2 text-sm">
          {outcome}
        </p>
      ) : null}
    </Card>
  );
}
