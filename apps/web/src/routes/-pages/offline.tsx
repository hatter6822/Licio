// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.1a/b + WS-R.17.2/17.3 — the offline-bundle page.  A reachable home for the
// import flow (open a `.licio-bundle` a peer shared with you), the §22.3 QR micro-bundle
// import, the §22.6 transport-status surface, and the honest §20/§25 offline-state
// chips (outbox / conflict) driven by the REAL local store — never a fabricated signal.
// The export flow is per-room and is surfaced from a room; this page hosts the universal
// import side.  The OfflineBundlePanel loads the @licio/lcap pack codec lazily (this
// route is itself code-split), and the always-available surfaces mirror state locally,
// so the codec stays off the initial bundle.

import { useEffect, useState } from 'react';
import { OfflineBundlePanel } from '../../components/lcap/OfflineBundlePanel/index.js';
import { ConflictWarning, OutboxStatus } from '../../components/lcap/OfflineStates/index.js';
import { P2pSyncPanel } from '../../components/lcap/P2pSyncPanel/index.js';
import { QrMicroBundle } from '../../components/lcap/QrMicroBundle/index.js';
import { TransportStatus } from '../../components/lcap/TransportStatus/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useT } from '../../i18n/index.js';
import { getOperationalMode } from '../../lcap/mode-state.js';
import { type OfflineStatusSummary, readOfflineStatus } from '../../lcap/offline-status.js';

export function OfflineBundlePage(): React.ReactElement {
  const t = useT();
  const mode = getOperationalMode();
  const [status, setStatus] = useState<OfflineStatusSummary | null>(null);

  // Read the REAL local offline state once on mount, so the chips reflect actual outbox
  // / conflict state rather than a fabricated value.
  useEffect(() => {
    let active = true;
    void readOfflineStatus().then((summary) => {
      if (active) setStatus(summary);
    });
    return () => {
      active = false;
    };
  }, []);

  const outboxTotal = status
    ? status.outbox.queued + status.outbox.retrying + status.outbox.exported
    : 0;

  return (
    <>
      <PageHeader title={t('lcap.bundle.pageTitle', 'Offline bundles')} />
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
        <p className="text-sm text-ink-muted">
          {t(
            'lcap.bundle.pageIntro',
            'Licio content can travel as signed, content-addressed bundles — so a room stays readable even with no connection. Import one here; export a room from the room itself.',
          )}
        </p>

        {/* The REAL §20/§25 local state — only shown when there is something to report. */}
        {status && (outboxTotal > 0 || status.hasConflict) ? (
          <section className="flex flex-col gap-2" aria-labelledby="lcap-state-heading">
            <h2 id="lcap-state-heading" className="text-base font-semibold text-ink">
              {t('lcap.bundle.stateHeading', 'Pending offline state')}
            </h2>
            {status.hasConflict ? <ConflictWarning kind="device_fork" /> : null}
            <div className="flex flex-wrap gap-2">
              {status.outbox.queued > 0 ? <OutboxStatus state="queued" /> : null}
              {status.outbox.retrying > 0 ? (
                <OutboxStatus state="retrying" attempt={status.maxRetryAttempt} />
              ) : null}
              {status.outbox.exported > 0 ? <OutboxStatus state="exported" /> : null}
            </div>
          </section>
        ) : null}

        <OfflineBundlePanel />

        <section className="flex flex-col gap-3" aria-labelledby="lcap-p2p-sync-section-heading">
          <h2 id="lcap-p2p-sync-section-heading" className="text-base font-semibold text-ink">
            {t('lcap.p2pSync.sectionHeading', 'Sync over a direct connection')}
          </h2>
          <p className="text-sm text-ink-muted">
            {t(
              'lcap.p2pSync.sectionIntro',
              'Exchange a public room directly with another device, peer to peer, when the server is slow or unreachable — with the Licio server as the fallback.',
            )}
          </p>
          <P2pSyncPanel />
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="lcap-qr-heading">
          <h2 id="lcap-qr-heading" className="text-base font-semibold text-ink">
            {t('lcap.qr.heading', 'QR micro-bundles')}
          </h2>
          <p className="text-sm text-ink-muted">
            {t(
              'lcap.qr.pageIntro',
              'Import a tiny control object (an invite or contact card) from a photo of a QR code. Its contents are summarized before you decide to import.',
            )}
          </p>
          <QrMicroBundle />
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="lcap-transport-heading">
          <h2 id="lcap-transport-heading" className="text-base font-semibold text-ink">
            {t('lcap.transport.heading', 'How content moves')}
          </h2>
          <TransportStatus mode={mode} />
        </section>
      </div>
    </>
  );
}
