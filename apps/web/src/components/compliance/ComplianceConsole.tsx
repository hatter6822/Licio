// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.1c / WS-N.2.2c — the compliance console (the moderation-console
// pattern): the case queue with the guarded review state machine, the fraud
// queue (flagged intents + fraud-class cases) with release/reject + SLA due
// times, and the WS-N.1.1f declaration-verification form.  Authorization is
// SERVER-side (compliance role + active MFA); a non-reviewer sees an access
// notice, never data.  Everything shown is transaction-derived only
// (WS-N.2.2d) — this surface structurally cannot render attention data
// because no API it calls carries any.
import type {
  CaseResolutionOutcome,
  FinancialComplianceCase,
  FraudQueueResponse,
} from '@licio/shared';
import { useEffect, useState } from 'react';
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

type Tab = 'cases' | 'fraud' | 'declarations';

export function ComplianceConsole(): React.JSX.Element {
  const t = useT();
  const [tab, setTab] = useState<Tab>('cases');
  const [cases, setCases] = useState<FinancialComplianceCase[] | null>(null);
  const [queue, setQueue] = useState<FraudQueueResponse['items'] | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [caseList, fraudQueue] = await Promise.all([adminListCases(), adminFetchFraudQueue()]);
      setCases(caseList.cases);
      setQueue(fraudQueue.items);
      setDenied(false);
      setError(null);
    } catch (e) {
      if (e instanceof ApiClientError && (e.status === 403 || e.status === 401)) {
        setDenied(true);
        return;
      }
      setError(t('compliance.console.load_error', 'Could not load the compliance queues.'));
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load — `refresh` is a fresh closure each render; depending on it would refetch every render.
  useEffect(() => {
    void refresh();
  }, []);

  if (denied) {
    return (
      <Card as="section">
        <h2 className="text-base font-semibold">
          {t('compliance.console.denied.title', 'Compliance access required')}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          {t(
            'compliance.console.denied.body',
            'This workspace is restricted to the financial-compliance team (a dedicated role with active MFA — steward and admin roles deliberately do not grant it).',
          )}
        </p>
      </Card>
    );
  }

  return (
    <section aria-label={t('compliance.console.title', 'Compliance console')}>
      <h2 className="text-lg font-semibold">
        {t('compliance.console.title', 'Compliance console')}
      </h2>
      {error !== null ? (
        <p role="alert" className="mt-2 text-sm text-error-fg">
          {error}
        </p>
      ) : null}
      <Tabs
        className="mt-3"
        label={t('compliance.console.title', 'Compliance console')}
        value={tab}
        onValueChange={(id) => setTab(id as Tab)}
        tabs={[
          { id: 'cases', label: t('compliance.console.cases', 'Cases') },
          { id: 'fraud', label: t('compliance.console.fraud', 'Fraud queue') },
          { id: 'declarations', label: t('compliance.console.declarations', 'Declarations') },
        ]}
      >
        {(activeId) =>
          activeId === 'cases' ? (
            <CaseQueue cases={cases} onChanged={() => void refresh()} />
          ) : activeId === 'fraud' ? (
            <FraudQueue items={queue} onChanged={() => void refresh()} />
          ) : (
            <DeclarationVerification />
          )
        }
      </Tabs>
    </section>
  );
}

function CaseQueue({
  cases,
  onChanged,
}: {
  cases: FinancialComplianceCase[] | null;
  onChanged: () => void;
}): React.JSX.Element {
  const t = useT();
  const [assignee, setAssignee] = useState('');
  const [notes, setNotes] = useState('');
  const [resolveOutcome, setResolveOutcome] = useState<CaseResolutionOutcome>('cleared');
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
  const act = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      setError(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Action failed');
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {error !== null ? (
        <p role="alert" className="text-sm text-error-fg">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <Input
          label={t('compliance.console.assignee', 'Assignee user id')}
          value={assignee}
          onChange={(event) => setAssignee(event.target.value)}
        />
        <Input
          label={t('compliance.console.notes', 'Resolution notes')}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <Select
          label={t('compliance.console.outcome', 'Resolution outcome')}
          value={resolveOutcome}
          onValueChange={(value) => setResolveOutcome(value as CaseResolutionOutcome)}
          options={RESOLVE_OUTCOMES.map((outcome) => ({
            value: outcome,
            label: t(`compliance.console.outcome.${outcome}`, OUTCOME_LABEL[outcome]),
          }))}
        />
      </div>
      <ul className="flex flex-col gap-2">
        {cases.map((record) => (
          <li key={record.case_id}>
            <Card as="article">
              <div className="flex flex-wrap items-center justify-between gap-2">
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
                <div className="flex flex-wrap gap-2">
                  {record.review_state === 'open' ? (
                    <Button
                      disabled={assignee.trim() === ''}
                      onClick={() =>
                        void act(() => adminAssignCase(record.case_id, assignee.trim()))
                      }
                    >
                      {t('compliance.console.assign', 'Assign')}
                    </Button>
                  ) : null}
                  {record.review_state === 'assigned' || record.review_state === 'escalated' ? (
                    <Button
                      onClick={() => void act(() => adminCaseAction(record.case_id, 'begin'))}
                    >
                      {t('compliance.console.begin', 'Begin investigation')}
                    </Button>
                  ) : null}
                  {record.review_state === 'investigating' ? (
                    <>
                      <Button
                        disabled={notes.trim() === ''}
                        onClick={() =>
                          void act(() =>
                            adminResolveCase(record.case_id, resolveOutcome, notes.trim()),
                          )
                        }
                      >
                        {t('compliance.console.resolve', 'Resolve: {outcome}', {
                          outcome: t(
                            `compliance.console.outcome.${resolveOutcome}`,
                            OUTCOME_LABEL[resolveOutcome],
                          ),
                        })}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => void act(() => adminCaseAction(record.case_id, 'escalate'))}
                      >
                        {t('compliance.console.escalate', 'Escalate')}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FraudQueue({
  items,
  onChanged,
}: {
  items: FraudQueueResponse['items'] | null;
  onChanged: () => void;
}): React.JSX.Element {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  if (items === null) {
    return <p className="text-sm text-ink-muted">{t('compliance.console.loading', 'Loading…')}</p>;
  }
  const held = items.filter((item) => item.payment_intent_id !== null);
  if (items.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid="empty-fraud">
        {t('compliance.console.noFraud', 'Nothing awaiting fraud review.')}
      </p>
    );
  }
  const review = async (decision: 'release' | 'reject', paymentIntentId: string): Promise<void> => {
    try {
      await adminReviewIntent(decision, paymentIntentId, `console ${decision}`);
      setError(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Review failed');
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
        {items.map((item, index) => (
          <li key={`${item.case.case_id}:${item.payment_intent_id ?? index}`}>
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
                {item.payment_intent_id !== null && item.payment_compliance_state === 'flagged' ? (
                  <div className="flex gap-2">
                    <Button
                      onClick={() => void review('release', item.payment_intent_id as string)}
                    >
                      {t('compliance.console.release', 'Release')}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void review('reject', item.payment_intent_id as string)}
                    >
                      {t('compliance.console.reject', 'Reject')}
                    </Button>
                  </div>
                ) : null}
              </div>
            </Card>
          </li>
        ))}
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
      setOutcome(e instanceof ApiClientError ? e.message : 'Verification failed');
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
