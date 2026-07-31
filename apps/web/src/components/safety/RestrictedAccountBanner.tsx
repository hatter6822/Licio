// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J restrict sanction — the banner that says so.
//
// A restricted account is allowed to sign in precisely so it can appeal and
// exercise its data rights, and the server enforces the sanction per WRITE
// route (403 `account_restricted`).  Without this, that account browses a UI
// that looks entirely normal until a post, comment, or widen fails with no
// explanation — silent failure, which is a worse answer than the login bounce
// it replaced.  `selectIsRestricted` existed for exactly this and nothing
// consulted it.
import { Link } from '@tanstack/react-router';
import { useT } from '../../i18n/index.js';
import { selectIsRestricted, useAuthStore } from '../../stores/index.js';
import { Icon } from '../ui/Icon/index.js';

/** Renders nothing unless the signed-in account is restricted. */
export function RestrictedAccountBanner({
  className,
}: {
  className?: string;
}): React.ReactElement | null {
  const t = useT();
  const restricted = useAuthStore(selectIsRestricted);
  if (!restricted) return null;
  return (
    // `role="status"` (polite), not `alert`: this is a standing condition the
    // reader arrived in, not an interruption — an assertive region would
    // re-announce it on every navigation.
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-md border border-line neu-inset p-3 text-sm"
    >
      <Icon
        name="octagon-exclamation"
        className={`mt-0.5 size-5 text-warning-on-soft ${className ?? ''}`}
      />
      <p className="text-ink">
        {t(
          'account.restricted',
          'Your account is restricted: you can read, manage your data, and appeal, but posting and public sharing are paused.',
        )}{' '}
        <Link
          to="/profile/safety"
          className="font-medium text-primary-on-soft underline-offset-2 hover:underline"
        >
          {t('account.restrictedAppeal', 'See the notice and appeal')}
        </Link>
        .
      </p>
    </div>
  );
}
