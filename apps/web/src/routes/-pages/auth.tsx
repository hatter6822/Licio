// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Login + not-found routes (WS-C.1.1a/d). The login route preserves an
// allowlisted post-login destination (open-redirect defense). The session/login
// backend is owned by WS-D; here the route is the contract surface that the auth
// guards redirect to. The not-found route renders inside the app shell (not a
// hard 404 page) so navigation chrome stays available.
import { Link, useSearch } from '@tanstack/react-router';
import { EmptyState } from '../../components/ui/EmptyState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useT } from '../../i18n/index.js';
import { sanitizeRedirect } from '../../routing/guards.js';
import { usePageFocus } from './usePageFocus.js';

export function LoginPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('login.title', 'Sign in'));
  const { redirect } = useSearch({ from: '/login' });
  const destination = sanitizeRedirect(redirect);

  return (
    <>
      <PageHeader title={t('login.title', 'Sign in')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <EmptyState
          icon="user"
          title={t('login.heading', 'Sign in to continue')}
          description={t(
            'login.description',
            'Sign-in is being connected. Once available, you will return to where you were.',
          )}
        />
        <p className="mt-4 text-center text-sm text-ink-muted">
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
