// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N compliance console page.  Authorization is enforced server-side; a
// non-reviewer sees an access notice rather than data (WS-N.2.1c-2).  The page
// owns the header (title + back button — the console is reached from the
// profile's Operations group) and syncs the active console tab to `?tab=` so a
// reviewer can bookmark or share a queue.
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ComplianceConsole } from '../../components/compliance/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useGoBack } from '../../hooks/useGoBack.js';
import { useT } from '../../i18n/index.js';
import { usePageFocus } from './usePageFocus.js';

export function ComplianceConsolePage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('compliance.console.title', 'Compliance console'));
  const navigate = useNavigate();
  // Retrace history to wherever the console was opened from (usually the
  // profile); a cold-loaded deep link falls back (replacing) to the profile.
  const goBack = useGoBack(() => void navigate({ to: '/profile', replace: true }));
  const { tab } = useSearch({ from: '/compliance-console' });
  return (
    <>
      <PageHeader title={t('compliance.console.title', 'Compliance console')} onBack={goBack} />
      <div className="mx-auto w-full max-w-3xl p-4">
        <ComplianceConsole
          {...(tab !== undefined ? { tab } : {})}
          onTabChange={(next) =>
            // Tab switches REPLACE the entry (the default tab clears the param):
            // browsing the queues must not bury the real back destination.
            void navigate({
              to: '/compliance-console',
              search: next === 'cases' ? {} : { tab: next },
              replace: true,
            })
          }
        />
      </div>
    </>
  );
}
