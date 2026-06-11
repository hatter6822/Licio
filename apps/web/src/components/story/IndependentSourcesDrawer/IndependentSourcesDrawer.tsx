// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "independent sources" drawer (WS-H.2.3b, SPEC §7.6; MERI-3): source
// lineage and exposure-independence context for a story, rendered from the
// STORED shadow MERI output + the source model — a page load never triggers
// invariant computation. The drawer is a native <details> disclosure
// (keyboard- and screen-reader-accessible without custom wiring), and its
// copy never implies that repetition equals truth.

import type { IndependentSourcesResponse } from '@licio/shared';
import { useT } from '../../../i18n/index.js';
import { ExposureLabel } from '../ExposureLabel/index.js';

export interface IndependentSourcesDrawerProps {
  data: IndependentSourcesResponse;
}

export function IndependentSourcesDrawer({
  data,
}: IndependentSourcesDrawerProps): React.ReactElement {
  const t = useT();
  return (
    <details className="rounded-lg border border-edge bg-surface p-3">
      <summary className="cursor-pointer text-sm font-medium text-ink">
        {t('exposure.drawer.title', 'Independent sources')}
      </summary>
      <div className="mt-3 flex flex-col gap-3 text-sm text-ink">
        {data.exposure_label ? (
          <div className="flex items-center gap-2">
            <ExposureLabel label={data.exposure_label} />
            <span className="text-xs text-ink-muted">
              {t(
                'exposure.drawer.labelNote',
                'How this story adds to what has already been shown — repetition is not independence.',
              )}
            </span>
          </div>
        ) : (
          <p className="text-xs text-ink-muted">
            {t('exposure.drawer.pending', 'Independence analysis has not covered this story yet.')}
          </p>
        )}
        {data.source ? (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {t('exposure.drawer.source', 'Source')}
            </h3>
            <p>{data.source.name}</p>
            {data.source.publisher_lineage.length > 0 ? (
              <p className="text-xs text-ink-muted">
                {t('exposure.drawer.ownership', 'Ownership lineage')}:{' '}
                {data.source.publisher_lineage.join(' → ')}
              </p>
            ) : null}
          </div>
        ) : null}
        <p className="text-xs text-ink-muted">
          {data.confirmed_syndication_count > 0
            ? t(
                'exposure.drawer.syndication',
                'This source has confirmed syndication relationships; syndicated copies share lineage and do not add independent exposure.',
              )
            : t(
                'exposure.drawer.noSyndication',
                'No confirmed syndication relationships are recorded for this source.',
              )}
        </p>
      </div>
    </details>
  );
}
