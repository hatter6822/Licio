// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.1a/b — the offline-bundle page.  A reachable home for the import flow (open
// a `.licio-bundle` a peer shared with you) and a brief explanation of offline
// availability.  The export flow is per-room and is surfaced from a room; this page
// hosts the universal import side.  The OfflineBundlePanel loads the @licio/lcap pack
// codec lazily (this route is itself code-split), so neither enters the initial bundle.

import { OfflineBundlePanel } from '../../components/lcap/OfflineBundlePanel/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useT } from '../../i18n/index.js';

export function OfflineBundlePage(): React.ReactElement {
  const t = useT();
  return (
    <>
      <PageHeader title={t('lcap.bundle.pageTitle', 'Offline bundles')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <p className="mb-4 text-sm text-ink-muted">
          {t(
            'lcap.bundle.pageIntro',
            'Licio content can travel as signed, content-addressed bundles — so a room stays readable even with no connection. Import one here; export a room from the room itself.',
          )}
        </p>
        <OfflineBundlePanel />
      </div>
    </>
  );
}
