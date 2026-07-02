// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — the §33 operational-mode page.  A reachable home for the operational-mode
// selector (minimal / standard / courier / relay / stealth / emergency) and the §22.6
// transport-status surface, so a user controls the whole client posture (storage,
// priority, media, discovery, export) from one place.  Honest copy throughout: the page
// states what each mode does and does NOT do, and surfaces the high-risk warning.
//
// Always-available surface: it reads the locally-mirrored mode state / transport catalog
// (no `@licio/lcap` codec import), so this route is not on the lazy bundle-codec chunk.

import { useState } from 'react';
import { CourierRunner } from '../../components/courier/CourierRunner/index.js';
import { OperationalModeSelector } from '../../components/lcap/OperationalModeSelector/index.js';
import { TransportStatus } from '../../components/lcap/TransportStatus/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useT } from '../../i18n/index.js';
import { getOperationalMode } from '../../lcap/mode-state.js';
import type { OperationalMode } from '../../lcap/operational-modes.js';
import { usePageFocus } from './usePageFocus.js';

export function OperationalModePage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('lcap.mode.pageTitle', 'Connection mode'));
  const [mode, setMode] = useState<OperationalMode>(() => getOperationalMode());
  return (
    <>
      <PageHeader title={t('lcap.mode.pageTitle', 'Connection mode')} />
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
        <p className="text-sm text-ink-muted">
          {t(
            'lcap.mode.pageIntro',
            'One choice sets how this device stores and moves Licio content: how much it caches, what it fetches, whether it finds nearby devices automatically, and how exports are named. Pick a mode below, then see exactly what it does.',
          )}
        </p>
        <section className="flex flex-col gap-3" aria-labelledby="lcap-mode-heading">
          <h2 id="lcap-mode-heading" className="text-base font-semibold text-ink">
            {t('lcap.mode.selectorHeading', 'Choose a mode')}
          </h2>
          <OperationalModeSelector onModeChange={setMode} />
        </section>
        <section className="flex flex-col gap-3" aria-labelledby="lcap-transport-heading">
          <h2 id="lcap-transport-heading" className="text-base font-semibold text-ink">
            {t('lcap.transport.heading', 'How content moves')}
          </h2>
          <TransportStatus mode={mode} />
        </section>
        <section className="flex flex-col gap-3" aria-labelledby="lcap-courier-heading">
          <h2 id="lcap-courier-heading" className="text-base font-semibold text-ink">
            {t('courier.section.heading', 'Nearby courier')}
          </h2>
          <p className="text-sm text-ink-muted">
            {t(
              'courier.section.intro',
              'Carry and re-share public content with devices around you when there is no connection. Off by default; you choose which radios to use and who to exchange with.',
            )}
          </p>
          <CourierRunner />
        </section>
      </div>
    </>
  );
}
