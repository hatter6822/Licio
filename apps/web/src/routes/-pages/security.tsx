// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Account security page (WS-D.1.2c/1.3c/1.4a/1.5 management surface): active
// sessions, sign-in methods (passkeys / email factor / wallets), TOTP
// two-factor, and the owner-visible security activity feed.  Sensitive
// mutations run through the step-up gate: a server challenge opens the step-up
// dialog and the SAME action retries on success, so intent is never lost.
// The server enforces the last-method guard; this page only renders its error.
import type { SecurityActivityEntry, SessionSummary } from '@licio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import {
  StepUpDialog,
  type StepUpGate,
  useStepUpGate,
} from '../../components/security/StepUpDialog/index.js';
import { Badge } from '../../components/ui/Badge/index.js';
import { Button } from '../../components/ui/Button/index.js';
import { Input } from '../../components/ui/Input/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useToast } from '../../components/ui/Toast/index.js';
import { formatDate } from '../../i18n/format.js';
import { useI18n, useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import {
  addEmail,
  addPasskey,
  confirmTotp,
  disableEmail,
  disableTotp,
  enrollTotp,
  removePasskey,
  removeWallet,
  renamePasskey,
  resendEmailCode,
  revokeOtherSessions,
  revokeSession,
  StepUpRequiredError,
  verifyEmail,
} from '../../lib/auth-api.js';
import {
  useAuthCredentialsQuery,
  useAuthSessionsQuery,
  useSecurityActivityQuery,
} from '../../lib/queries.js';
import { queryKeys } from '../../lib/query-keys.js';
import { isWebAuthnAvailable } from '../../lib/webauthn.js';
import { usePageFocus } from './usePageFocus.js';

type Translate = ReturnType<typeof useT>;

/** Map a flow failure to user-appropriate copy (never a raw stack). */
function failureMessage(error: unknown, t: Translate): string {
  if (error instanceof StepUpRequiredError) {
    return t('security.error.stepUpCancelled', 'Confirmation was cancelled.');
  }
  if (
    error instanceof Error &&
    /cancelled|NotAllowedError/i.test(`${error.name} ${error.message}`)
  ) {
    return t('security.error.cancelled', 'The passkey prompt was cancelled or timed out.');
  }
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case 'last_method':
        return t('security.error.lastMethod', 'Set up another way to sign in first.');
      case 'rate_limited':
      case 'cooldown':
        return t('security.error.rateLimited', 'Too many attempts. Please wait and try again.');
      case 'invalid_code':
        return t('security.error.invalidCode', 'That code is invalid or expired.');
      default:
        return error.message;
    }
  }
  return t('security.error.generic', 'Something went wrong. Please try again.');
}

function Section({ title, children }: { title: string; children: ReactNode }): React.ReactElement {
  return (
    <section className="flex flex-col gap-3 border-b border-line py-4">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function ErrorLine({ message }: { message: string | null }): React.ReactElement | null {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-error-on-soft">
      {message}
    </p>
  );
}

const METHOD_LABELS: Record<SessionSummary['auth_method'], string> = {
  webauthn: 'Passkey',
  email_otp: 'Email code',
  wallet: 'Wallet',
};

// --- Sessions (WS-D.1.3c) ------------------------------------------------------

function SessionsSection(): React.ReactElement {
  const t = useT();
  const { locale } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const sessions = useAuthSessionsQuery();
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.authSessions() });
  };

  return (
    <Section title={t('security.sessions', 'Active sessions')}>
      {sessions.data ? (
        <ul className="flex flex-col gap-3">
          {sessions.data.map((session) => (
            <li
              key={session.session_ref}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3"
            >
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-sm text-ink">
                  {session.device_label || t('security.sessions.unknown', 'Unknown device')}
                  {session.current ? (
                    <Badge tone="success">{t('security.sessions.current', 'This device')}</Badge>
                  ) : null}
                </span>
                <span className="text-xs text-ink-muted">
                  {METHOD_LABELS[session.auth_method]} ·{' '}
                  {t('security.sessions.lastActive', 'Last active')}{' '}
                  {formatDate(Date.parse(session.last_active_at), locale, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              </div>
              {!session.current ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    revokeSession(session.session_ref).then(refresh, (err: unknown) =>
                      setError(failureMessage(err, t)),
                    );
                  }}
                >
                  {t('security.sessions.revoke', 'Sign out')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">{t('security.loading', 'Loading…')}</p>
      )}
      <div>
        <Button
          variant="secondary"
          onClick={() => {
            revokeOtherSessions().then(
              (revoked) => {
                refresh();
                toast({
                  message: t('security.sessions.revokedOthers', 'Signed out other devices.'),
                });
                void revoked;
              },
              (err: unknown) => setError(failureMessage(err, t)),
            );
          }}
        >
          {t('security.sessions.revokeOthers', 'Sign out other devices')}
        </Button>
      </div>
      <ErrorLine message={error} />
    </Section>
  );
}

// --- Passkeys (WS-D.1.2c) ---------------------------------------------------------

function PasskeysSection({ gate }: { gate: StepUpGate }): React.ReactElement {
  const t = useT();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const credentials = useAuthCredentialsQuery();
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.authCredentials() });
  };
  const fail = (err: unknown): void => setError(failureMessage(err, t));

  return (
    <Section title={t('security.passkeys', 'Passkeys')}>
      {credentials.data && credentials.data.passkeys.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {credentials.data.passkeys.map((passkey) => (
            <li
              key={passkey.credential_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3"
            >
              <div className="flex flex-col gap-1">
                <span className="text-sm text-ink">
                  {passkey.device_name ?? t('security.passkeys.unnamed', 'Passkey')}
                </span>
                <span className="text-xs text-ink-muted">
                  {t('security.passkeys.added', 'Added')}{' '}
                  {formatDate(Date.parse(passkey.created_at), locale)}
                  {passkey.backed_up ? ` · ${t('security.passkeys.synced', 'Synced')}` : ''}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setRenaming(passkey.credential_id);
                    setRenameValue(passkey.device_name ?? '');
                  }}
                >
                  {t('security.passkeys.rename', 'Rename')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setError(null);
                    gate.guard(() => removePasskey(passkey.credential_id)).then(refresh, fail);
                  }}
                >
                  {t('security.passkeys.remove', 'Remove')}
                </Button>
              </div>
              {renaming === passkey.credential_id ? (
                <form
                  className="flex w-full items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    renamePasskey(passkey.credential_id, renameValue).then(() => {
                      setRenaming(null);
                      refresh();
                    }, fail);
                  }}
                >
                  <Input
                    label={t('security.passkeys.newName', 'New name')}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    required
                    className="grow"
                  />
                  <Button type="submit" variant="secondary">
                    {t('security.save', 'Save')}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">
          {t('security.passkeys.none', 'No passkeys enrolled yet.')}
        </p>
      )}
      {isWebAuthnAvailable() ? (
        <div>
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => {
              setError(null);
              setBusy(true);
              gate
                .guard(() => addPasskey())
                .then(refresh, fail)
                .finally(() => setBusy(false));
            }}
          >
            {t('security.passkeys.add', 'Add a passkey')}
          </Button>
        </div>
      ) : null}
      <ErrorLine message={error} />
    </Section>
  );
}

// --- Email factor (WS-D.1.4a) -------------------------------------------------------

function EmailSection({ gate }: { gate: StepUpGate }): React.ReactElement {
  const t = useT();
  const queryClient = useQueryClient();
  const credentials = useAuthCredentialsQuery();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [editing, setEditing] = useState(false);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.authCredentials() });
  };
  const fail = (err: unknown): void => setError(failureMessage(err, t));
  const state = credentials.data?.email;

  return (
    <Section title={t('security.email', 'Email sign-in')}>
      {state ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
          {state.present ? (
            <>
              <span>{t('security.email.onFile', 'An email address is on file.')}</span>
              <Badge tone={state.verified ? 'success' : 'warning'}>
                {state.verified
                  ? t('security.email.verified', 'Verified')
                  : t('security.email.unverified', 'Unverified')}
              </Badge>
            </>
          ) : (
            <span>
              {t('security.email.none', 'No email on this account (passkey/wallet only).')}
            </span>
          )}
        </div>
      ) : null}

      {state?.present && !state.verified ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            verifyEmail(code).then(() => {
              setCode('');
              refresh();
            }, fail);
          }}
        >
          <Input
            label={t('security.email.code', 'Verification code')}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            className="grow"
          />
          <Button type="submit" variant="secondary">
            {t('security.email.verify', 'Verify')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setError(null);
              resendEmailCode().then(() => undefined, fail);
            }}
          >
            {t('security.email.resend', 'Resend code')}
          </Button>
        </form>
      ) : null}

      {editing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            gate
              .guard(() => addEmail(email))
              .then(() => {
                setEditing(false);
                setAwaitingCode(true);
                refresh();
              }, fail);
          }}
        >
          <Input
            label={t('security.email.new', 'New email')}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="grow"
          />
          <Button type="submit" variant="secondary">
            {t('security.email.sendCode', 'Send code')}
          </Button>
        </form>
      ) : null}

      {awaitingCode ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            verifyEmail(code).then(() => {
              setCode('');
              setAwaitingCode(false);
              refresh();
            }, fail);
          }}
        >
          <Input
            label={t('security.email.code', 'Verification code')}
            helperText={t(
              'security.email.staged',
              'Your current email stays active until the new one is confirmed.',
            )}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            className="grow"
          />
          <Button type="submit" variant="secondary">
            {t('security.email.confirm', 'Confirm')}
          </Button>
        </form>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => setEditing((v) => !v)}>
          {state?.present
            ? t('security.email.change', 'Change email')
            : t('security.email.add', 'Add email')}
        </Button>
        {state?.present ? (
          <Button
            variant="ghost"
            onClick={() => {
              setError(null);
              gate.guard(() => disableEmail()).then(refresh, fail);
            }}
          >
            {t('security.email.disable', 'Remove email sign-in')}
          </Button>
        ) : null}
      </div>
      <ErrorLine message={error} />
    </Section>
  );
}

// --- Wallets (WS-D.1.4c) --------------------------------------------------------------

function WalletsSection({ gate }: { gate: StepUpGate }): React.ReactElement | null {
  const t = useT();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const credentials = useAuthCredentialsQuery();
  const [error, setError] = useState<string | null>(null);
  const wallets = credentials.data?.wallets ?? [];

  if (credentials.data && wallets.length === 0) {
    // No linked wallets and linking is a login-time flow: nothing to manage.
    return null;
  }

  return (
    <Section title={t('security.wallets', 'Linked wallets')}>
      <ul className="flex flex-col gap-3">
        {wallets.map((wallet) => (
          <li
            key={wallet.credential_id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3"
          >
            <div className="flex flex-col gap-1">
              <span className="font-mono text-sm text-ink">{wallet.address_truncated}</span>
              <span className="text-xs text-ink-muted">
                {t('security.wallets.chain', 'Chain')} {wallet.chain_id} ·{' '}
                {t('security.wallets.linked', 'Linked')}{' '}
                {formatDate(Date.parse(wallet.created_at), locale)}
              </span>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                gate
                  .guard(() => removeWallet(wallet.credential_id))
                  .then(
                    () =>
                      void queryClient.invalidateQueries({
                        queryKey: queryKeys.authCredentials(),
                      }),
                    (err: unknown) => setError(failureMessage(err, t)),
                  );
              }}
            >
              {t('security.wallets.unlink', 'Unlink')}
            </Button>
          </li>
        ))}
      </ul>
      <ErrorLine message={error} />
    </Section>
  );
}

// --- TOTP two-factor (WS-D.1.5) ----------------------------------------------------------

function TotpSection({ gate }: { gate: StepUpGate }): React.ReactElement {
  const t = useT();
  const queryClient = useQueryClient();
  const credentials = useAuthCredentialsQuery();
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.authCredentials() });
  };
  const fail = (err: unknown): void => setError(failureMessage(err, t));
  const totp = credentials.data?.totp;

  return (
    <Section title={t('security.totp', 'Two-factor authentication (TOTP)')}>
      <p className="text-sm text-ink-muted">
        {t(
          'security.totp.desc',
          'A time-based code from an authenticator app. Required for stewards; recommended for everyone.',
        )}
      </p>

      {totp?.enabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success">{t('security.totp.enabled', 'Enabled')}</Badge>
          <Button
            variant="ghost"
            onClick={() => {
              setError(null);
              gate
                .guard(() => disableTotp())
                .then(() => {
                  setUri(null);
                  setRecoveryCodes(null);
                  refresh();
                }, fail);
            }}
          >
            {t('security.totp.disable', 'Disable')}
          </Button>
        </div>
      ) : null}

      {!totp?.enabled && !uri ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setError(null);
              gate.guard(() => enrollTotp()).then(setUri, fail);
            }}
          >
            {t('security.totp.enroll', 'Set up two-factor')}
          </Button>
        </div>
      ) : null}

      {uri && !recoveryCodes ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">
            {t(
              'security.totp.addToApp',
              'Add this to your authenticator app, then confirm with a code:',
            )}
          </p>
          <code className="break-all rounded-md border border-line bg-surface-sunken p-2 text-xs text-ink">
            {uri}
          </code>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              gate
                .guard(() => confirmTotp(code))
                .then((codes) => {
                  setRecoveryCodes(codes);
                  setCode('');
                  refresh();
                }, fail);
            }}
          >
            <Input
              label={t('security.totp.code', '6-digit code')}
              autoComplete="one-time-code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              className="grow"
            />
            <Button type="submit" variant="primary">
              {t('security.totp.confirm', 'Confirm')}
            </Button>
          </form>
        </div>
      ) : null}

      {recoveryCodes ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-ink">
            {t(
              'security.totp.recovery',
              'Recovery codes — store these somewhere safe. Each works once; this is the only time they are shown.',
            )}
          </p>
          <ul className="grid grid-cols-2 gap-1 rounded-md border border-line bg-surface-sunken p-3 font-mono text-xs text-ink">
            {recoveryCodes.map((recoveryCode) => (
              <li key={recoveryCode}>{recoveryCode}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <ErrorLine message={error} />
    </Section>
  );
}

// --- Recent security activity (WS-D.1.6c owner view) -----------------------------------

function ActivitySection(): React.ReactElement {
  const t = useT();
  const { locale } = useI18n();
  const activity = useSecurityActivityQuery();

  const label = (entry: SecurityActivityEntry): string => entry.event_type.replace(/_/g, ' ');

  return (
    <Section title={t('security.activity', 'Recent security activity')}>
      {activity.data && activity.data.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {activity.data.slice(0, 20).map((entry) => (
            <li key={entry.event_id} className="flex flex-wrap justify-between gap-2 text-sm">
              <span className="text-ink">
                {label(entry)}
                {entry.context.auth_method ? (
                  <span className="text-ink-muted">
                    {' '}
                    · {METHOD_LABELS[entry.context.auth_method]}
                  </span>
                ) : null}
                {entry.context.device ? (
                  <span className="text-ink-muted"> · {entry.context.device}</span>
                ) : null}
              </span>
              <span className="text-xs text-ink-muted">
                {formatDate(Date.parse(entry.created_at), locale, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">
          {t('security.activity.none', 'No recent security events.')}
        </p>
      )}
    </Section>
  );
}

export function SecurityPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('security.title', 'Security'));
  const gate = useStepUpGate();

  return (
    <>
      <PageHeader title={t('security.title', 'Security')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <SessionsSection />
        <PasskeysSection gate={gate} />
        <EmailSection gate={gate} />
        <WalletsSection gate={gate} />
        <TotpSection gate={gate} />
        <ActivitySection />
      </div>
      <StepUpDialog {...gate.dialog} />
    </>
  );
}
