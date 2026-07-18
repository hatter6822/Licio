// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J user-facing safety pages: the published support contact (unauthenticated),
// the moderation-notice inbox (statement of reasons + appeal), and the block /
// mute management surface.  Each page owns its header (title + back button —
// they are reached from the profile's Safety & support group) and the standard
// centered content column; the components render the surface only.
import { useNavigate } from '@tanstack/react-router';
import { NoticeInbox } from '../../components/safety/NoticeInbox.js';
import { SafetyRelations } from '../../components/safety/SafetyRelations.js';
import { SupportContact } from '../../components/safety/SupportContact.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useGoBack } from '../../hooks/useGoBack.js';
import { useT } from '../../i18n/index.js';
import { usePageFocus } from './usePageFocus.js';

export function SupportPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('support.title', 'Get help'));
  const navigate = useNavigate();
  // Reachable WITHOUT authentication (a locked-out user still needs support),
  // so the cold-load fallback replaces to the front page, never the profile.
  const goBack = useGoBack(() => void navigate({ to: '/', replace: true }));
  return (
    <>
      <PageHeader title={t('support.title', 'Get help')} onBack={goBack} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <SupportContact />
      </div>
    </>
  );
}

export function NoticesPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('notices.title', 'Notices'));
  const navigate = useNavigate();
  const goBack = useGoBack(() => void navigate({ to: '/profile', replace: true }));
  return (
    <>
      <PageHeader title={t('notices.title', 'Notices')} onBack={goBack} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <NoticeInbox />
      </div>
    </>
  );
}

export function RelationsPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('safety.relations', 'Blocked & muted'));
  const navigate = useNavigate();
  const goBack = useGoBack(() => void navigate({ to: '/profile', replace: true }));
  return (
    <>
      <PageHeader title={t('safety.relations', 'Blocked & muted')} onBack={goBack} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <SafetyRelations />
      </div>
    </>
  );
}
