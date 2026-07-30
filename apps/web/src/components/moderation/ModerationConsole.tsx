// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2 moderation console (steward workspace): the priority/SLA-sorted report
// queue (emergency on top) + full-context review with the action palette
// (WS-J.2.1/2.2/2.3), the Sources review queue (the STEWARD_ROLES.md
// ROLE_EVIDENCE doctrine surface over citation-bearing contributions — sourcing
// is comment-centric, so the user-facing name is "Sources"), the appeal review
// interface enforcing independence (WS-J.2.4), and the audit viewer (WS-J.2.5).
// Authorization is enforced server-side; a non-steward simply sees an access
// notice.  No financial data appears on any surface.  The page header (title +
// back button) belongs to the route page — this component renders the tabbed
// workspace only, optionally controlled so the active tab can live in the URL.
import {
  type AppealQueueRow,
  type AppealReviewResponse,
  type CaseReviewResponse,
  type ConsoleAction,
  canonicalJson,
  type EvidenceDecisionRequest,
  type ModerationCaseRow,
  type ModerationReasonCode,
  REVIEWER_AVAILABILITY,
  type ReviewerAvailability,
} from '@licio/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider.js';
import { ApiClientError } from '../../lib/api.js';
import { verifyTotp } from '../../lib/auth-api.js';
import { saveBlob } from '../../lib/privacy-api.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  applyEvidenceDecision,
  applyModerationAction,
  assignCase,
  decideAppeal,
  exportAudit,
  fetchAppeal,
  fetchAppealQueue,
  fetchAudit,
  fetchCase,
  fetchEvidenceDecisions,
  fetchEvidenceQueue,
  fetchIncidents,
  fetchReportQueue,
  fetchReviewerStatus,
  fetchUrlVerdict,
  resolveIncident,
  revertModerationAction,
  setReviewerStatus,
} from '../../lib/safety-api.js';
import { useAuthStore } from '../../stores/auth.js';
import { REPORT_REASONS_BY_CODE } from '../safety/report-reasons.js';
import { Badge } from '../ui/Badge/index.js';
import { Button } from '../ui/Button/index.js';
import { Dialog } from '../ui/Dialog/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { Input } from '../ui/Input/index.js';
import { Select } from '../ui/Select/index.js';
import { Tabs } from '../ui/Tabs/index.js';
import { TextArea } from '../ui/TextArea/index.js';
import { useToast } from '../ui/Toast/index.js';

const REASON_OPTIONS = [...REPORT_REASONS_BY_CODE.values()].map((r) => ({
  value: r.code,
  label: `${r.code} — ${r.label}`,
}));

/** Humanize a ratified WS-A reason code for display: the taxonomy label with
 *  the code kept alongside (stewards cross-reference codes in audit exports),
 *  falling back to the bare code for anything outside the taxonomy. */
function reasonLabel(code: string): string {
  const reason = REPORT_REASONS_BY_CODE.get(code as ModerationReasonCode);
  return reason ? `${reason.label} (${code})` : code;
}

/** Human names for the invariant signals (SPEC §7–§12) — the console must not
 *  surface bare acronyms a rotating steward has to memorize. */
const SIGNAL_LABELS: Record<'mfci' | 'scoi' | 'phi' | 'hodge', string> = {
  mfci: 'Coordination (MFCI)',
  scoi: 'Context obstruction (SCOI)',
  phi: 'Preference holonomy (PHI)',
  hodge: 'Hodge tension',
};

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
  approaching: 'text-warning-on-soft',
  breached: 'text-error-on-soft font-semibold',
};

function isForbidden(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 403;
}

/**
 * The session holds the steward role but has NOT cleared MFA on THIS session.
 *
 * Distinct from a role denial even though both are 403: `mfa_required` is
 * recoverable right here, and a role denial is not.  Only the ENROLLING session
 * is marked verified server-side (`/mfa/totp/confirm`), so every later sign-in
 * starts unverified — without this branch a steward saw "your role does not
 * have access", which is both wrong and a dead end.
 */
function isMfaRequired(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 403 && error.code === 'mfa_required';
}

/** The steward holds the role but has never ENROLLED MFA.  A verification form
 *  cannot help — there is no authenticator to read a code from — so this gets
 *  its own notice pointing at enrolment.  The server distinguishes the two
 *  because one code for both is a form that can never succeed. */
/**
 * The steward holds the role but has never enrolled MFA.  Distinct from the
 * verification form: there is no code to enter yet, so the repair is enrolment
 * in account security, not a challenge on this session.
 */
function MfaEnrollmentNotice(): React.ReactElement {
  const t = useT();
  return (
    <div className="neu-raised rounded-lg p-4" role="status">
      <h2 className="font-medium text-ink">
        {t('console.mfaEnrollTitle', 'Set up two-factor authentication')}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        {t(
          'console.mfaEnrollBody',
          'Steward accounts require two-factor authentication. Enrol an authenticator in account security, then reopen the console.',
        )}
      </p>
    </div>
  );
}

function isMfaEnrollmentRequired(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    error.status === 403 &&
    error.code === 'mfa_enrollment_required'
  );
}

/** A TRUE authentication failure (the api client has already flipped the auth
 *  store to session-expired for it): retrying cannot succeed until the steward
 *  signs in again, so it must never render as a transient error. */
function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
}

/**
 * WS-J.2.6b: an untrusted external link (a reporter-supplied evidence URL, or a
 * citation under source review) resolves the SERVER-side redirect-chain malware
 * verdict before the reviewer navigates (the URLs are stored, never fetched at
 * submission time).  Until a verdict exists the trigger is a BUTTON, not an
 * anchor — an `href` would let middle-click, context-menu "open in new tab",
 * and other non-click activations bypass the check entirely.  `malicious`
 * replaces it with a blocked notice; `unavailable` warns but leaves the
 * reviewer in control ("open anyway" — the reviewer IS the human-review path);
 * `clear` surfaces a real `rel="noreferrer noopener"` anchor rather than
 * auto-opening: this is an untrusted destination, and `window.open` cannot
 * withhold the Referer (its `noreferrer` feature string would also null the
 * SUCCESS return, making popup blocking undetectable), so the deliberate
 * second click on the anchor is the referrer-safe navigation path.
 */
function CheckedLink({ url }: { url: string }): React.ReactElement {
  const t = useT();
  const [state, setState] = useState<'idle' | 'checking' | 'clear' | 'malicious' | 'unavailable'>(
    'idle',
  );

  const activate = (): void => {
    if (state === 'checking') return;
    setState('checking');
    void fetchUrlVerdict(url)
      .then(({ verdict }) => setState(verdict))
      .catch(() => {
        // Fail toward flagging: an unreachable check warns, never silently opens.
        setState('unavailable');
      });
  };

  if (state === 'malicious') {
    return (
      <span role="status" className="font-semibold text-error-on-soft">
        {t('console.linkMalicious', 'Blocked: this link resolves to a known malicious site.')}{' '}
        <span className="font-normal text-ink-muted line-through">{url}</span>
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="text-left text-primary-on-soft underline"
        onClick={activate}
        title={t('console.linkCheckTitle', 'Checks this link for malware before opening')}
      >
        {url}
      </button>
      {state === 'checking' ? (
        <span role="status" className="ml-1 text-ink-muted">
          {t('console.linkChecking', 'checking link…')}
        </span>
      ) : null}
      {state === 'unavailable' ? (
        <span role="status" className="ml-1 text-warning-on-soft">
          {t('console.linkUnverified', 'Could not verify this link.')}{' '}
          <a href={url} target="_blank" rel="noreferrer noopener" className="underline">
            {t('console.linkOpenAnyway', 'Open anyway')}
          </a>
        </span>
      ) : null}
      {state === 'clear' ? (
        <span role="status" className="ml-1 text-ink-muted">
          {t('console.linkVerified', 'Verified.')}{' '}
          <a href={url} target="_blank" rel="noreferrer noopener" className="underline">
            {t('console.linkOpen', 'Open link')}
          </a>
        </span>
      ) : null}
    </>
  );
}

/** The console's tab ids — also the `?tab=` deep-link vocabulary (WS-C.1.1b). */
export type ModerationConsoleTab = 'queue' | 'sources' | 'appeals' | 'integrity' | 'audit';

export interface ModerationConsoleProps {
  /** Controlled active tab (the page syncs it to `?tab=`); omit for local state. */
  tab?: ModerationConsoleTab;
  onTabChange?: (tab: ModerationConsoleTab) => void;
}

export function ModerationConsole({
  tab,
  onTabChange,
}: ModerationConsoleProps = {}): React.ReactElement {
  const t = useT();
  return (
    <section aria-label={t('console.title', 'Moderation console')} className="flex flex-col gap-4">
      <ReviewerStatusControl />
      <Tabs
        label={t('console.tabs', 'Console sections')}
        {...(tab !== undefined ? { value: tab } : {})}
        {...(onTabChange !== undefined
          ? { onValueChange: (id: string) => onTabChange(id as ModerationConsoleTab) }
          : {})}
        tabs={[
          { id: 'queue', label: t('console.queue', 'Report queue') },
          { id: 'sources', label: t('console.sources', 'Sources') },
          { id: 'appeals', label: t('console.appeals', 'Appeals') },
          { id: 'integrity', label: t('console.integrity', 'Integrity') },
          { id: 'audit', label: t('console.audit', 'Audit log') },
        ]}
      >
        {(activeId) => (
          <>
            {activeId === 'queue' ? <ReportQueuePanel /> : null}
            {activeId === 'sources' ? <SourcesPanel /> : null}
            {activeId === 'appeals' ? <AppealsPanel /> : null}
            {activeId === 'integrity' ? <IncidentsPanel /> : null}
            {activeId === 'audit' ? <AuditPanel /> : null}
          </>
        )}
      </Tabs>
    </section>
  );
}

/**
 * The reviewer's own availability (WS-J.2.1d).
 *
 * This is the input side of the assignment machinery the queue already reads:
 * `/v1/moderation/queue?assignment=…` filters by assignee and the case row
 * carries `assigned_to_handle`, but nothing let a steward say whether they were
 * takingdocket work at all — the route and the client call both existed with no
 * control in front of them, so the server's routing could only ever see every
 * steward as equally available.
 *
 * Local optimistic state, reverted on failure: availability is a hint the server
 * owns, and a control that silently kept showing `available` after a failed
 * write would mislead the one person who needs to know.
 */
function ReviewerStatusControl(): React.ReactElement | null {
  const t = useT();
  const { toast } = useToast();
  // INITIALISED FROM THE SERVER, not from a local default.  A fixed
  // `available` told a reviewer they were in the auto-assignment pool while
  // `availableIds()` still excluded them — and merely opening the console did
  // not correct it, so the control stated the opposite of the truth for as long
  // as the reviewer believed it.  `undefined` until the read lands, so the
  // select shows the real value rather than flashing a wrong one.
  const stored = useQuery({
    queryKey: queryKeys.modReviewerStatus(),
    queryFn: fetchReviewerStatus,
    retry: false,
  });
  // THE CACHE, not mount-local state.  A successful write recorded the new value
  // only in a `useState`, so navigating away and back inside the 30 s staleTime
  // re-rendered the STALE cached GET with no refetch at all — the reviewer saw
  // `available` while the server had them `offline` and `availableIds()` excluded
  // them.  It was also never cleared, so after one write the control showed the
  // local value for the rest of the mount and no background refetch could correct
  // it.
  //
  // `setQueryData` BEFORE the invalidate, and from the mutation's `next` VARIABLE
  // — never its result, which is `{ok: true}` and would seed a shape with no
  // status at all.  Seeding first means a failed post-write refetch cannot roll
  // the display back to the pre-write value; the invalidate keeps the server
  // authoritative.
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (next: ReviewerAvailability) => setReviewerStatus(next),
    // OFFLINE FAILS FAST rather than being queued.  The default `online` mode
    // PAUSES the mutation and `resumePausedMutations` replays it on reconnect, so
    // a reviewer could flip their availability offline, see no error, and have the
    // write land minutes later — or, if their role cannot set it at all, get the
    // 403 toast then.
    networkMode: 'always',
    onSuccess: (_data, next) => {
      queryClient.setQueryData(queryKeys.modReviewerStatus(), { status: next });
      void queryClient.invalidateQueries({ queryKey: queryKeys.modReviewerStatus() });
    },
    onError: (e) =>
      toast({
        message: isForbidden(e)
          ? t('console.statusForbidden', 'Your role cannot set a reviewer status.')
          : t('console.statusFailed', 'Could not update your availability.'),
        tone: 'error',
      }),
  });
  // THE SERVER'S ANSWER decides whether this control belongs here.  Both the
  // status GET and its POST reject a steward who can reach neither the report
  // nor the appeal queue — an evidence-only or integrity-only grant, which
  // legitimately enters this console for its OWN tabs.  Rendering the control
  // for them meant a 403 on open and a 403 on every change: a switch that can
  // only fail.  Re-deriving the rule client-side from `steward_roles` would
  // duplicate an authorization decision and drift from it; the refusal itself
  // is the authoritative read.
  if (isForbidden(stored.error)) return null;
  // GATED ON A CONFIRMED VALUE, not on a boolean flag.  Keying the absence off
  // `isLoading` made the control fail OPEN for everything that is not a 403: a
  // 502, an `invalid_response`, a bare network reject, and — worst — the OFFLINE
  // case, where the default `online` networkMode PAUSES the query so `isLoading`
  // is false and `error` is null.  Combined with the `?? 'offline'` fallback below
  // it rendered a CONFIDENT `offline` that the server had never said, fully
  // interactive, to a reviewer the server still had in the auto-assignment pool.
  //
  // `stored.data?.status === undefined` is the only formulation that closes all of
  // them: `isLoading` is `isPending && isFetching`, and a paused query is
  // pending-but-not-fetching, so any predicate built from those flags leaves the
  // offline hole open. It also keeps a WORKING control through a failed
  // background refetch, because the last good data is still there.
  const status = stored.data?.status;
  if (status === undefined) {
    // Still on the first read: say nothing rather than flash a failure.
    if (stored.isLoading) return null;
    // Unknown, and honest about it — no fabricated value, and nothing to click.
    return (
      <p role="status" className="text-ink-muted text-sm">
        {t(
          'console.statusUnknown',
          'Your availability could not be read — it is unchanged on the server.',
        )}
      </p>
    );
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <Select
        label={t('console.availability', 'My availability')}
        value={status}
        disabled={update.isPending}
        onValueChange={(v) => update.mutate(v as ReviewerAvailability)}
        options={REVIEWER_AVAILABILITY.map((value) => ({
          value,
          label: t(`console.availability.${value}`, value),
        }))}
      />
    </div>
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

/**
 * Clear MFA on the CURRENT session (WS-D.1.5b) and retry.
 *
 * `denyCapability` requires `mfa_verified` for every steward action, and only
 * `/v1/auth/mfa/totp/verify` sets it on an already-authenticated session.  This
 * is the affordance that calls it — a steward whose enrolment session has ended
 * has no other way back into the console.  Recovery codes are accepted by the
 * same endpoint, so a steward without their authenticator is not locked out.
 */
function MfaVerifyNotice({ onVerified }: { onVerified: () => void }): React.ReactElement {
  const t = useT();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  /** Which failure to show — the four are NOT interchangeable advice. */
  const [failure, setFailure] = useState<'none' | 'rejected' | 'expired' | 'throttled' | 'error'>(
    'none',
  );

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (code.trim().length === 0 || busy) return;
    setBusy(true);
    setFailure('none');
    try {
      await verifyTotp(code);
      setCode('');
      onVerified();
    } catch (error) {
      // Only a REJECTED CODE is reported opaquely — a wrong code and an unknown
      // recovery code must stay indistinguishable so the form is not an oracle
      // on which codes exist.  The other three say nothing about any code, and
      // collapsing them into "that code was not accepted" is actively wrong
      // advice: an expired session can NEVER succeed on retry, and a
      // rate-limited steward would be told to keep hammering the endpoint.
      if (error instanceof ApiClientError) {
        if (error.status === 401) setFailure('expired');
        else if (error.status === 429) setFailure('throttled');
        else if (error.status !== undefined && error.status >= 500) setFailure('error');
        else setFailure('rejected');
      } else {
        setFailure('error'); // network / parse: transient, not a code verdict
      }
    } finally {
      setBusy(false);
    }
  };

  const message: Record<Exclude<typeof failure, 'none'>, string> = {
    rejected: t('console.mfaFailed', 'That code was not accepted. Try again.'),
    expired: t('console.mfaExpired', 'Your session has expired. Sign in again to continue.'),
    throttled: t('console.mfaThrottled', 'Too many attempts. Wait a moment before trying again.'),
    error: t('console.mfaUnavailable', 'Verification is unavailable right now. Try again shortly.'),
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-3 rounded-md border border-line bg-canvas p-4"
    >
      <p className="text-ink-muted">
        {t(
          'console.mfaRequired',
          'Verify your authenticator to use the moderation console on this session.',
        )}
      </p>
      <Input
        label={t('console.mfaCodeLabel', 'Authenticator or recovery code')}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        autoComplete="one-time-code"
        // NOT `numeric`: the field also takes a RECOVERY code, which is
        // Crockford base32 (`generateRecoveryCodes`) — letters included.  A
        // digits-only virtual keyboard would make the fallback untypeable on
        // mobile, precisely when the authenticator is the thing unavailable.
        inputMode="text"
        disabled={busy}
      />
      {failure !== 'none' ? (
        <p role="alert" className="text-error-on-soft">
          {message[failure]}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy || code.trim().length === 0}>
          {t('console.mfaVerify', 'Verify')}
        </Button>
      </div>
    </form>
  );
}

/** The session lapsed mid-use (401 — the api client already flipped the auth
 *  store to `session-expired`; the route guards redirect on the next protected
 *  navigation). Say so and point at sign-in — never "retry". */
function SessionExpiredNotice(): React.ReactElement {
  const t = useT();
  return (
    <p className="rounded-md border border-line bg-canvas p-4 text-ink-muted">
      {t('console.sessionExpired', 'Your session has expired.')}{' '}
      <Link to="/login" className="font-medium text-primary-on-soft underline hover:no-underline">
        {t('console.signInAgain', 'Sign in again')}
      </Link>{' '}
      {t('console.sessionExpiredTail', 'to continue reviewing.')}
    </p>
  );
}

/**
 * Honest per-panel failure state: a 403 is an AUTHORIZATION outcome, a 401 is an
 * AUTHENTICATION outcome (the session lapsed — sign in again; retrying cannot
 * succeed), and only everything else — network, 5xx, malformed payload — is a
 * transient error with a retry.  Collapsing these told a fully-authorized
 * steward their role lost access whenever the API blipped, or that an expired
 * session was "not a permissions problem, retry", both wrong.
 *
 * The 403s split further: `mfa_required` is RECOVERABLE on this session, so it
 * gets the verification form rather than the dead-end access notice.
 */
function PanelError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const t = useT();
  if (isMfaEnrollmentRequired(error)) return <MfaEnrollmentNotice />;
  if (isMfaRequired(error)) return <MfaVerifyNotice onVerified={onRetry} />;
  if (isForbidden(error)) return <AccessNotice />;
  if (isUnauthenticated(error)) return <SessionExpiredNotice />;
  return (
    <ErrorState
      title={t('console.panelError', 'This console section could not load')}
      description={t(
        'console.panelErrorDetail',
        'The request failed — this is not a permissions problem. Retry, and check that the API is reachable.',
      )}
      headingLevel={3}
      onRetry={onRetry}
    />
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
  if (queue.isError) return <PanelError error={queue.error} onRetry={() => void queue.refetch()} />;
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
                <span className="flex flex-wrap items-center gap-1.5 font-medium text-ink">
                  {/* Text-carried emergency marker (never an emoji glyph alone). */}
                  {row.routed_to === 'emergency' ? (
                    <Badge tone="error">{t('console.emergency', 'Emergency')}</Badge>
                  ) : null}
                  {row.reason_codes.map(reasonLabel).join(', ')}
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

  // WS-J.2.3b revert.  The reason is asked for SEPARATELY, never inherited from
  // the action palette above: the server records this field as the reason for
  // the REVERSAL in the action and the audit trail, so reusing the palette's
  // pending new-action selection (which initialises to `MOD_HARASS_001`) would
  // write "harassment" as the justification for undoing an unrelated spam or
  // mistaken sanction — a false entry in the one record that is supposed to
  // explain what a steward did and why.
  const [revertTarget, setRevertTarget] = useState<string | null>(null);
  /** ONE way to close this dialog, because there were three ways to leave the
   *  reason behind.  Clearing it only on SUCCESS meant a steward could pick a
   *  reason, cancel, open Revert on a DIFFERENT action, and find that reason
   *  already selected with confirmation enabled — recording a justification
   *  they never chose for that action.  A dialog that asks a question has to
   *  forget the answer when it is dismissed. */
  const closeRevert = (): void => {
    setRevertTarget(null);
    setRevertReason('');
  };
  // EMPTY until the steward chooses.  A pre-selected code plus an enabled
  // confirm is a default the dialog can record without anyone deciding
  // anything: open it on a mistaken spam sanction, click Revert, and the audit
  // trail says the reversal was for harassment.  Asking the question is only
  // asking it if an answer is required.
  const [revertReason, setRevertReason] = useState<ModerationReasonCode | ''>('');
  // Keyed by the action being undone so only that row spins.
  const revert = useMutation({
    // Unreachable with an empty reason — the confirm button is disabled until
    // one is chosen — but typed so it stays that way.
    mutationFn: (actionId: string) =>
      revertModerationAction(actionId, revertReason as ModerationReasonCode),
    onSuccess: () => {
      toast({ message: t('console.revertDone', 'Action reverted.'), tone: 'success' });
      closeRevert();
      void queryClient.invalidateQueries({ queryKey: queryKeys.modCase(caseId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.modAudit('default') });
    },
    onError: (e) =>
      toast({
        message: isForbidden(e)
          ? t('console.revertForbidden', 'Your role cannot revert that action.')
          : t('console.revertFailed', 'The action could not be reverted.'),
        tone: 'error',
      }),
  });

  // WS-J.2.1d self-assignment.  The route takes any `reviewer_id`, but the only
  // id a console user can name without a reviewer directory is their own, so
  // this is the "claim it" affordance the queue's `assignment=mine` filter has
  // always been able to read and nothing could ever write.
  const selfId = useAuthStore((s) => s.user?.id);
  const claim = useMutation({
    mutationFn: (reviewerId: string) => assignCase(caseId, reviewerId),
    onSuccess: () => {
      toast({ message: t('console.claimDone', 'Case assigned to you.'), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.modCase(caseId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.modQueue('default') });
    },
    onError: (e) =>
      toast({
        message: isForbidden(e)
          ? t('console.claimForbidden', 'Your role cannot take this case.')
          : t('console.claimFailed', 'Could not assign this case to you.'),
        tone: 'error',
      }),
  });

  return (
    <Dialog open onClose={onClose} title={t('console.reviewTitle', 'Review case')}>
      {review.isLoading ? (
        <p className="text-ink-muted">{t('common.loading', 'Loading…')}</p>
      ) : null}
      {review.isError ? (
        <p role="alert" className="text-error-on-soft">
          {isForbidden(review.error)
            ? t('console.caseForbidden', 'Your role cannot open this case for review.')
            : isUnauthenticated(review.error)
              ? t('console.sessionExpiredCase', 'Your session has expired — sign in again.')
              : t('console.caseReviewError', 'Could not load this case for review.')}
        </p>
      ) : null}
      {data ? (
        <div className="flex flex-col gap-4">
          <section
            aria-label={t('console.assignment', 'Assignment')}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="text-ink-muted">
              {data.assigned_to_id === null
                ? t('console.unassigned', 'Unassigned')
                : data.assigned_to_id === selfId
                  ? t('console.assignedToYou', 'Assigned to you')
                  : t('console.assignedToOther', 'Assigned to another reviewer')}
            </span>
            {/* CLAIMING is for an UNASSIGNED case.  Offering it while another
                reviewer holds the case let any report reviewer silently take
                their in-progress work — the mutation overwrites the assignment
                and sends no reason, so the audit entry records the handover
                with `notes: null`.  Taking a case off a colleague is a
                reasoned reassignment, which is a different flow with a
                different record; this control is not it. */}
            {selfId !== undefined && data.assigned_to_id === null ? (
              <Button
                variant="ghost"
                loading={claim.isPending}
                onClick={() => claim.mutate(selfId)}
              >
                {t('console.claim', 'Take this case')}
              </Button>
            ) : null}
          </section>

          <section aria-label={t('console.reports', 'Reports')}>
            <h3 className="text-xs font-semibold uppercase text-ink-muted">
              {t('console.reports', 'Reports')}
            </h3>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {data.reports.map((r) => (
                <li key={r.report_id} className="rounded bg-surface p-2">
                  <span className="font-medium text-ink">{reasonLabel(r.reason_code)}</span>
                  {r.context ? <span className="text-ink-muted"> — {r.context}</span> : null}
                  {r.reporter_handle ? (
                    <span className="ml-1 text-xs text-ink-muted">({r.reporter_handle})</span>
                  ) : null}
                  {r.evidence_urls.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {r.evidence_urls.map((url) => (
                        <li key={url} className="truncate text-xs">
                          <span className="text-ink-muted">
                            {t('console.reportEvidence', 'Evidence')}:{' '}
                          </span>
                          {/* Reporter-supplied links resolve the WS-J.2.6b
                              server-side malware verdict before navigation and
                              open with no referrer/opener leakage. */}
                          <CheckedLink url={url} />
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
                  {SIGNAL_LABELS[k]}:{' '}
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
            {/* The prior actions THEMSELVES, not just a count.  Each carries an
                `action_id` and a `reverted` flag the payload has always sent,
                and WS-J.2.3b's revert route was reachable from no surface — so
                a wrongly-applied sanction could be seen (as a number) and never
                undone.  Reverting asks for its OWN reason (the dialog below);
                the palette's pending new-action selection is a different
                decision and would write "harassment" as the justification for
                undoing an unrelated sanction. */}
            {data.user_history.past_actions.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-1 text-xs">
                {data.user_history.past_actions.map((entry) => (
                  <li
                    key={entry.action_id}
                    className="flex items-center justify-between gap-2 rounded bg-surface p-2"
                  >
                    <span className="text-ink">
                      {entry.action}
                      {entry.reason_code ? ` · ${reasonLabel(entry.reason_code)}` : ''}
                      <span className="text-ink-muted"> · {entry.created_at.slice(0, 10)}</span>
                    </span>
                    {entry.reverted ? (
                      <Badge tone="neutral">{t('console.reverted', 'Reverted')}</Badge>
                    ) : entry.reversible ? (
                      <Button
                        variant="ghost"
                        loading={revert.isPending && revert.variables === entry.action_id}
                        onClick={() => setRevertTarget(entry.action_id)}
                      >
                        {t('console.revert', 'Revert')}
                      </Button>
                    ) : (
                      // Bans, lawful-basis removals and the workflow verbs are
                      // recorded non-reversible and `revertAction` refuses them
                      // with `not_reversible` — so offering the control here
                      // would only ever produce an error toast.
                      <span className="text-xs text-ink-muted">
                        {t('console.notReversible', 'Not reversible')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {data.side_by_side ? (
            <section aria-label={t('console.diff', 'Edited since report')} className="text-xs">
              <h3 className="text-xs font-semibold uppercase text-warning-on-soft">
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
      {/* The reversal asks for its OWN reason.  The server records this field as
          the justification for undoing the action, in the action row and the
          audit trail, so inheriting the palette's pending new-action selection
          would write a reason the steward never chose. */}
      {revertTarget !== null ? (
        <Dialog open onClose={closeRevert} title={t('console.revertTitle', 'Revert this action')}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">
              {t(
                'console.revertBody',
                'Why is this action being undone? This is recorded as the reason for the reversal.',
              )}
            </p>
            <Select
              label={t('console.revertReason', 'Reversal reason')}
              value={revertReason}
              placeholder={t('console.revertReasonPlaceholder', 'Choose a reason…')}
              onValueChange={(v) => setRevertReason(v as ModerationReasonCode)}
              options={REASON_OPTIONS}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeRevert}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="primary"
                loading={revert.isPending}
                disabled={revertReason === ''}
                onClick={() => revert.mutate(revertTarget)}
              >
                {t('console.revertConfirm', 'Revert action')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Dialog>
  );
}

/** The Sources tab — STEWARD_ROLES.md ROLE_EVIDENCE: the FIFO queue of
 *  citation-bearing contributions (sourced comments + corrections) awaiting a
 *  source steward's review.  Sourcing is comment-centric (a comment carries
 *  `citations`), so the user-facing surface speaks "sources"; the doctrine role
 *  and the `/v1/moderation/evidence-*` wire endpoints keep their ratified
 *  names.  Decisions are source METADATA — never a content action
 *  (ROLE_EVIDENCE holds no removal power): `mark-primary-source` and
 *  `flag-citation` annotate ONE citation, `clear` marks the contribution
 *  reviewed with no annotation.  Every decision lands in the reviewable
 *  "Recent decisions" trail below the queue. */
function SourcesPanel(): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [flagTarget, setFlagTarget] = useState<{
    contributionId: string;
    citationUrl: string;
  } | null>(null);
  const queue = useInfiniteQuery({
    queryKey: queryKeys.modSourceQueue(),
    queryFn: ({ pageParam }) => fetchEvidenceQueue(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
  const decisions = useInfiniteQuery({
    queryKey: queryKeys.modSourceDecisions(),
    queryFn: ({ pageParam }) => fetchEvidenceDecisions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.modSourceQueue() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.modSourceDecisions() });
  };
  const decide = useMutation({
    mutationFn: (request: EvidenceDecisionRequest) => applyEvidenceDecision(request),
    onSuccess: () => {
      toast({
        message: t('console.sourceDecided', 'Source decision recorded.'),
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
              'console.sourceDuplicate',
              'This contribution was already reviewed by another steward.',
            )
          : isForbidden(e)
            ? t('console.sourceForbidden', 'Your role cannot record that decision.')
            : t('console.sourceDecisionFailed', 'Could not record that decision.'),
        tone: duplicate ? 'info' : 'error',
      });
      if (duplicate) refresh();
    },
  });
  if (queue.isError) return <PanelError error={queue.error} onRetry={() => void queue.refetch()} />;
  const rows = queue.data?.pages.flatMap((p) => p.items) ?? [];
  const decisionRows = decisions.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">
        {t(
          'console.sourcesHelp',
          'Source decisions annotate citations (primary source / flagged) or mark a contribution reviewed. They never remove content.',
        )}
      </p>
      {queue.data && rows.length === 0 ? (
        <p className="text-ink-muted">
          {t('console.sourcesQueueEmpty', 'The source review queue is clear.')}
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
                  ? t('console.sourceTypeCorrection', 'correction')
                  : t('console.sourceTypeComment', 'comment')}
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
                        url-verdict route accepts source stewards too). */}
                    <CheckedLink url={citation.url} />
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
              {d.reason_code ? (
                <span className="text-ink-muted"> · {reasonLabel(d.reason_code)}</span>
              ) : null}
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
              {t('console.noDecisions', 'No source decisions yet.')}
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
  if (appeals.isError) {
    return <PanelError error={appeals.error} onRetry={() => void appeals.refetch()} />;
  }
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
                {t('console.sla', 'SLA')}: {a.sla_state}
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
        <p className="text-error-on-soft">
          {isUnauthenticated(review.error)
            ? t('console.sessionExpiredCase', 'Your session has expired — sign in again.')
            : t('console.appealReviewError', 'Could not load this appeal for review.')}
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
              {data.original_reason_code ? ` · ${reasonLabel(data.original_reason_code)}` : ''}
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
              <h3 className="text-xs font-semibold uppercase text-warning-on-soft">
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
  if (incidents.isError) {
    return <PanelError error={incidents.error} onRetry={() => void incidents.refetch()} />;
  }
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
  const { toast } = useToast();
  const audit = useInfiniteQuery({
    queryKey: queryKeys.modAudit('default'),
    queryFn: ({ pageParam }) => fetchAudit(pageParam ? { cursor: pageParam } : {}),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });
  // WS-J.2.5 transparency export.  The endpoint and its small-cell suppression
  // existed with no way to reach them, so the aggregate a steward is meant to
  // publish could only be produced by hand from the paginated log — which is
  // exactly how a suppression threshold gets forgotten.  Saved as the canonical
  // JSON the server returned, unmodified, so what is published is what was
  // computed.
  const exporting = useMutation({
    mutationFn: () => exportAudit(),
    onSuccess: (report) => {
      saveBlob(
        new Blob([canonicalJson(report)], { type: 'application/json' }),
        `moderation-transparency-${report.period_start.slice(0, 10)}-to-${report.period_end.slice(0, 10)}.json`,
      );
      toast({
        message: t('console.exportDone', 'Transparency report downloaded.'),
        tone: 'success',
      });
    },
    onError: (e) =>
      toast({
        message: isForbidden(e)
          ? t('console.exportForbidden', 'Your role cannot export the audit log.')
          : t('console.exportFailed', 'Could not build the transparency report.'),
        tone: 'error',
      }),
  });
  if (audit.isError) return <PanelError error={audit.error} onRetry={() => void audit.refetch()} />;
  const items = audit.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <div className="flex justify-end">
        <Button variant="ghost" loading={exporting.isPending} onClick={() => exporting.mutate()}>
          {t('console.export', 'Export transparency report')}
        </Button>
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((entry) => (
          <li key={entry.audit_id} className="rounded bg-surface p-2">
            <span className="font-medium text-ink">{entry.action}</span>
            {entry.reason_code ? (
              <span className="text-ink-muted"> · {reasonLabel(entry.reason_code)}</span>
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
    </>
  );
}
