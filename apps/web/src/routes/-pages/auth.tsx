// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Login + not-found routes.  The login page is the WS-D.1.2d client surface:
// passkey-FIRST sign-in and account creation, with the emailed one-time code as
// the universal fallback — never a password.  The flows live in
// `lib/auth-api.ts` (zod-validated, ceremony plumbing in `lib/webauthn.ts`);
// this page owns only presentation and the post-login redirect, which is
// allowlisted via sanitizeRedirect (open-redirect defense).  Anti-enumeration
// copy is deliberate: email registration shows the SAME neutral guidance
// whether or not the address already had an account.
import type { UserContext } from '@licio/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button/index.js';
import { EmptyState } from '../../components/ui/EmptyState/index.js';
import { Input } from '../../components/ui/Input/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { Tabs } from '../../components/ui/Tabs/index.js';
import { formatDate } from '../../i18n/format.js';
import { useI18n, useT } from '../../i18n/index.js';
import { ApiClientError, fetchAuthStatus } from '../../lib/api.js';
import {
  loginWithPasskey,
  registerWithEmail,
  signupWithPasskey,
  startEmailLogin,
  verifyEmailLogin,
} from '../../lib/auth-api.js';
import { primeSignupCaptcha } from '../../lib/pow-captcha.js';
import { cancelAccountDeletion } from '../../lib/privacy-api.js';
import { useDeletionStatusQuery } from '../../lib/queries.js';
import { isWebAuthnAvailable } from '../../lib/webauthn.js';
import { sanitizeRedirect } from '../../routing/guards.js';
import { useAuthStore } from '../../stores/auth.js';
import { usePageFocus } from './usePageFocus.js';

type Translate = ReturnType<typeof useT>;

/** Map a thrown flow error to user-appropriate copy (never a raw stack). */
function messageFor(error: unknown, t: Translate): string {
  if (
    error instanceof Error &&
    /cancelled|NotAllowedError/i.test(`${error.name} ${error.message}`)
  ) {
    return t('login.error.cancelled', 'The passkey prompt was cancelled or timed out.');
  }
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case 'rate_limited':
      case 'cooldown':
        return t('login.error.rateLimited', 'Too many attempts. Please wait and try again.');
      case 'invalid_code':
        return t('login.error.invalidCode', 'That code is invalid or expired.');
      case 'auth_failed':
        return t('login.error.authFailed', 'Sign-in failed. Please try again.');
      case 'handle_taken':
        return t('login.error.handleTaken', 'That handle is unavailable.');
      case 'age_restricted':
        return t('login.error.ageRestricted', 'We are unable to create an account.');
      case 'captcha_required':
      case 'captcha_invalid':
        // The flows auto-solve and retry once; reaching the UI means both
        // attempts were rejected (offline, or a device without WebCrypto).
        return t(
          'login.error.captcha',
          'We could not verify your device automatically. Check your connection and try again.',
        );
      default:
        return error.message;
    }
  }
  return t('login.error.generic', 'Something went wrong. Please try again.');
}

interface PanelProps {
  onSignedIn: (user: UserContext) => void;
}

function SignInPanel({ onSignedIn }: PanelProps): React.ReactElement {
  const t = useT();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passkeysAvailable = isWebAuthnAvailable();

  const run = async (flow: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await flow();
    } catch (err) {
      setError(messageFor(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 pt-4">
      {passkeysAvailable ? (
        <>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void run(async () => onSignedIn(await loginWithPasskey()))}
          >
            {t('login.passkey', 'Sign in with a passkey')}
          </Button>
          <p className="text-center text-sm text-ink-muted" aria-hidden="true">
            {t('login.or', 'or')}
          </p>
        </>
      ) : null}

      {codeSent ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => onSignedIn(await verifyEmailLogin(code)));
          }}
        >
          <Input
            label={t('login.code', 'Sign-in code')}
            helperText={t('login.codeHelp', 'Enter the 8-character code we emailed you.')}
            autoComplete="one-time-code"
            inputMode="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          <Button type="submit" variant="primary" loading={busy}>
            {t('login.codeSubmit', 'Sign in')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setCodeSent(false)}>
            {t('login.codeBack', 'Use a different email')}
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await startEmailLogin(email);
              setCodeSent(true);
            });
          }}
        >
          <Input
            label={t('login.email', 'Email')}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Button
            type="submit"
            variant={passkeysAvailable ? 'secondary' : 'primary'}
            loading={busy}
          >
            {t('login.emailSubmit', 'Email me a sign-in code')}
          </Button>
        </form>
      )}

      {error ? (
        <p role="alert" className="text-sm text-error-on-soft">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CreateAccountPanel({ onSignedIn }: PanelProps): React.ReactElement {
  const t = useT();
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const passkeysAvailable = isWebAuthnAvailable();

  // Bot-prevention layer 1: start fetching + solving the sign-up proof-of-work
  // in a Web Worker the moment this panel mounts, so the one-time CPU cost
  // overlaps with the user typing and submission stays instant.  Silent and
  // privacy-free: pure CPU over server-supplied random bytes, no user data.
  useEffect(() => {
    primeSignupCaptcha();
  }, []);

  const profile = { handle, display_name: displayName, date_of_birth: dateOfBirth };
  const profileReady = handle.length >= 3 && displayName.length > 0 && dateOfBirth.length === 10;

  const run = async (flow: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await flow();
    } catch (err) {
      setError(messageFor(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-4">
      <Input
        label={t('login.create.handle', 'Handle')}
        helperText={t('login.create.handleHelp', '3–30 letters, numbers, or underscores.')}
        autoComplete="username"
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        required
      />
      <Input
        label={t('login.create.displayName', 'Display name')}
        autoComplete="name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        required
      />
      <Input
        label={t('login.create.dob', 'Date of birth')}
        helperText={t('login.create.dobHelp', 'Used once to confirm your age band — never stored.')}
        type="date"
        autoComplete="bday"
        value={dateOfBirth}
        onChange={(e) => setDateOfBirth(e.target.value)}
        required
      />

      {passkeysAvailable ? (
        <>
          <Button
            variant="primary"
            loading={busy}
            disabled={!profileReady}
            onClick={() => void run(async () => onSignedIn(await signupWithPasskey(profile)))}
          >
            {t('login.create.passkey', 'Create account with a passkey')}
          </Button>
          <p className="text-center text-sm text-ink-muted" aria-hidden="true">
            {t('login.or', 'or')}
          </p>
        </>
      ) : null}

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const outcome = await registerWithEmail({ ...profile, email });
            if (outcome.user) {
              onSignedIn(outcome.user);
            } else {
              setNotice(
                t(
                  'login.create.neutral',
                  'If that address was available, your account is ready and a verification code is in your inbox. If it already belongs to an account, sign in instead.',
                ),
              );
            }
          });
        }}
      >
        <Input
          label={t('login.email', 'Email')}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Button
          type="submit"
          variant={passkeysAvailable ? 'secondary' : 'primary'}
          loading={busy}
          disabled={!profileReady}
        >
          {t('login.create.emailSubmit', 'Create account with email')}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-error-on-soft">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-ink-muted">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Lands the emailed deletion-cancellation link (WS-D.2.4a): redeems the
 * single-use token once, reports the outcome, then hands back to sign-in.
 */
function EmailedCancelPanel({ onDone }: { onDone: () => void }): React.ReactElement {
  const t = useT();
  const { cancel_token } = useSearch({ from: '/login' });
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || !cancel_token) return;
    ran.current = true; // the token is single-use; redeem it exactly once
    cancelAccountDeletion(cancel_token).then(
      () => setState('done'),
      () => setState('failed'),
    );
  }, [cancel_token]);

  return (
    <div className="flex flex-col gap-4 pt-4 text-center">
      <p className="text-sm text-ink" role="status">
        {state === 'working'
          ? t('login.cancelDeletion.working', 'Cancelling the deletion request…')
          : state === 'done'
            ? t(
                'login.cancelDeletion.done',
                'Account deletion cancelled. Sign in to continue where you left off.',
              )
            : t(
                'login.cancelDeletion.failed',
                'This link is no longer valid. If your account is still scheduled for deletion, sign in to cancel it.',
              )}
      </p>
      {state !== 'working' ? (
        <Button variant="primary" onClick={onDone}>
          {t('login.cancelDeletion.continue', 'Continue to sign in')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Shown after a grace-period re-login (the account is deactivated pending
 * deletion): displays the purge date and offers to cancel, restoring the
 * account and completing the sign-in.
 */
function DeletionPendingPanel({
  onCancelled,
}: {
  onCancelled: (user: UserContext) => void;
}): React.ReactElement {
  const t = useT();
  const { locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read through the query layer like every other server read: a bespoke
  // useEffect + useState copy of the same fetch gets no caching, no retry
  // policy, and no shared invalidation, and it drifts from the hook the rest of
  // the app would use.
  const status = useDeletionStatusQuery().data ?? null;

  return (
    <div className="flex flex-col gap-4 pt-4">
      <p className="text-sm text-ink" role="status">
        {t('login.deletionPending.heading', 'This account is scheduled for deletion.')}{' '}
        {status?.purge_at
          ? `${t(
              'login.deletionPending.purgeOn',
              'It will be permanently removed on',
            )} ${formatDate(Date.parse(status.purge_at), locale)}.`
          : ''}
      </p>
      <Button
        variant="primary"
        loading={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          cancelAccountDeletion()
            .then(async () => {
              // The account is active again; the existing session now carries
              // full capability — hydrate the context and finish the sign-in.
              const auth = await fetchAuthStatus();
              if (auth.authenticated) onCancelled(auth.user);
            })
            .catch(() =>
              setError(t('login.deletionPending.failed', 'Could not cancel. Please try again.')),
            )
            .finally(() => setBusy(false));
        }}
      >
        {t('login.deletionPending.cancel', 'Cancel deletion and keep my account')}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-error-on-soft">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function LoginPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('login.title', 'Sign in'));
  const { redirect, cancel_token } = useSearch({ from: '/login' });
  const destination = sanitizeRedirect(redirect);
  const navigate = useNavigate();
  const status = useAuthStore((s) => s.status);
  const setAuthenticated = useAuthStore((s) => s.setAuthenticated);
  const [deletionPending, setDeletionPending] = useState(false);
  const [tokenHandled, setTokenHandled] = useState(false);

  // Deep-linking to /login while already signed in: bounce to the destination,
  // REPLACING /login in history.  A push would leave /login as a live back
  // target, and this effect would re-fire and bounce forward off it on every
  // Back — trapping the reader at /login↔destination (the requireAuth redirect
  // already REPLACES the guarded route with /login, so /login sits directly on
  // the pre-login entry; replacing it here lets Back reach that entry).
  useEffect(() => {
    if (status === 'authenticated') void navigate({ to: destination, replace: true });
  }, [status, destination, navigate]);

  const onSignedIn = (user: UserContext): void => {
    if (user.account_state === 'deactivated') {
      // Grace-period re-login (WS-D.2.4a): the session is cancel-only — offer
      // the cancellation instead of completing the sign-in.
      setDeletionPending(true);
      return;
    }
    setAuthenticated(user);
    // REPLACE (not push) so the consumed /login entry is removed: Back from the
    // destination returns to where the reader was before signing in, never onto
    // /login (which would immediately bounce forward again).
    void navigate({ to: destination, replace: true });
  };

  const showCancelToken = Boolean(cancel_token) && !tokenHandled;

  return (
    <>
      <PageHeader title={t('login.title', 'Sign in')} />
      <div className="mx-auto w-full max-w-md p-4">
        {showCancelToken ? (
          <EmailedCancelPanel onDone={() => setTokenHandled(true)} />
        ) : deletionPending ? (
          <DeletionPendingPanel onCancelled={onSignedIn} />
        ) : (
          <Tabs
            label={t('login.tabs', 'Sign in or create an account')}
            defaultValue="signin"
            tabs={[
              { id: 'signin', label: t('login.tab.signin', 'Sign in') },
              { id: 'create', label: t('login.tab.create', 'Create account') },
            ]}
          >
            {(active) =>
              active === 'signin' ? (
                <SignInPanel onSignedIn={onSignedIn} />
              ) : (
                <CreateAccountPanel onSignedIn={onSignedIn} />
              )
            }
          </Tabs>
        )}
        <p className="mt-6 text-center text-sm text-ink-muted">
          <Link to={destination} className="text-primary-on-soft underline">
            {t('login.back', 'Go back')}
          </Link>
        </p>
      </div>
    </>
  );
}

export function NotFoundPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('notfound.title', 'Page not found'));
  return (
    <>
      <PageHeader title={t('notfound.title', 'Page not found')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <EmptyState
          icon="circle-question"
          title={t('notfound.heading', "We couldn't find that page")}
          description={t(
            'notfound.description',
            'The link may be broken or the page may have moved.',
          )}
        />
        <p className="mt-4 text-center text-sm text-ink-muted">
          <Link to="/" className="text-primary-on-soft underline">
            {t('notfound.home', 'Go to the Front Page')}
          </Link>
        </p>
      </div>
    </>
  );
}
