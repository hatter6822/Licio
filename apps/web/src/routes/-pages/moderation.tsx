// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2 moderation console page (steward workspace).  Authorization is enforced
// server-side; a non-steward sees an access notice rather than data.  The page
// owns the header (title + back button — the console is reached from the
// profile's Operations group) and syncs the active console tab to `?tab=` so an
// operator can bookmark or share a queue.
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ModerationConsole } from '../../components/moderation/ModerationConsole.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useGoBack } from '../../hooks/useGoBack.js';
import { useT } from '../../i18n/index.js';
import { usePageFocus } from './usePageFocus.js';

export function ModerationConsolePage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('console.title', 'Moderation console'));
  const navigate = useNavigate();
  // Retrace history to wherever the console was opened from (usually the
  // profile); a cold-loaded deep link falls back (replacing) to the profile.
  const goBack = useGoBack(() => void navigate({ to: '/profile', replace: true }));
  const { tab } = useSearch({ from: '/moderation' });
  return (
    <>
      <PageHeader title={t('console.title', 'Moderation console')} onBack={goBack} />
      <div className="mx-auto w-full max-w-3xl p-4">
        <ModerationConsole
          {...(tab !== undefined ? { tab } : {})}
          onTabChange={(next) =>
            // Tab switches REPLACE the entry (the default tab clears the param):
            // browsing five queues must not bury the real back destination under
            // five history entries.
            void navigate({
              to: '/moderation',
              search: next === 'queue' ? {} : { tab: next },
              replace: true,
            })
          }
        />
      </div>
    </>
  );
}
