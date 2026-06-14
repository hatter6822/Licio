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
    <details className="rounded-lg border border-line bg-surface p-3">
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
        {data.co_group_stories.length > 0 ? (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {t('exposure.drawer.coGroup', 'Same coverage elsewhere')}
            </h3>
            <ul className="mt-1 flex flex-col gap-1">
              {data.co_group_stories.map((member) => (
                <li key={member.story_id} className="flex items-baseline gap-2">
                  <a
                    href={`/stories/${member.story_id}`}
                    className="text-sm text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    {member.title}
                  </a>
                  <span className="text-xs text-ink-muted">
                    {member.relationship === 'syndicated'
                      ? t('exposure.drawer.relSyndicated', 'syndicated')
                      : t('exposure.drawer.relNearDuplicate', 'near-duplicate')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}
