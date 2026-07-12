// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Independent-sources drawer (SPEC §7.6; WS-H.2.3a — MERI).  A story-level
// affordance that opens a Sheet describing how much genuinely NEW sourcing this
// story adds: the exposure label, the source's publisher lineage, the stories
// sharing its redundancy class, steward-reviewed primary sources, and the
// story's claims grouped by independence lineage.  Everything is DESCRIPTIVE
// and absence-honest — a value the invariant has not computed renders as "not
// yet computed", never a fabricated judgment — and the fixed caption keeps the
// §13.6 doctrine visible: repetition is not independence.  Both reads are lazy
// (`enabled` only once the sheet opens), so a story load costs nothing.
import type { MeriExposureLabelWire } from '@licio/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { useIndependentSourcesQuery, useStoryClaimsQuery } from '../../../lib/queries.js';
import { Button } from '../../ui/Button/index.js';
import { Sheet } from '../../ui/Sheet/index.js';

/** Plain-language exposure lines (WS-H.2.3a).  Purely descriptive of how this
 *  story relates to prior coverage — never a truth or quality judgment. */
const EXPOSURE_LINES: Record<MeriExposureLabelWire, { key: string; fallback: string }> = {
  independent_source: { key: 'sources.exposure.independent', fallback: 'Independent source' },
  new_angle: { key: 'sources.exposure.newAngle', fallback: 'New angle' },
  same_claim_new_evidence: {
    key: 'sources.exposure.sameClaimNewEvidence',
    fallback: 'Same claim, new evidence',
  },
  duplicate_context: { key: 'sources.exposure.duplicateContext', fallback: 'Duplicate context' },
};

function SectionHeading({ children }: { children: React.ReactNode }): React.ReactElement {
  return <h3 className="text-xs font-semibold uppercase text-ink-muted">{children}</h3>;
}

export interface IndependentSourcesDrawerProps {
  storyId: string;
}

export function IndependentSourcesDrawer({
  storyId,
}: IndependentSourcesDrawerProps): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const sources = useIndependentSourcesQuery(storyId, open);
  const claims = useStoryClaimsQuery(storyId, open);

  const data = sources.data;
  const claimItems = claims.data?.items ?? [];
  // Number the distinct MERI independence groups in appearance order so a
  // shared lineage reads as a subtle "lineage group N" annotation.
  const groupIndex = new Map<string, number>();
  for (const claim of claimItems) {
    if (claim.independence_group_id !== null && !groupIndex.has(claim.independence_group_id)) {
      groupIndex.set(claim.independence_group_id, groupIndex.size + 1);
    }
  }

  return (
    <>
      <Button variant="secondary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {t('sources.trigger', 'Independent sources')}
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('sources.title', 'Independent sources')}
      >
        <div className="flex flex-col gap-4">
          {/* The §13.6 doctrine, always visible: seeing a claim repeated is not
              the same as seeing it independently confirmed. */}
          <p className="text-xs text-ink-muted">
            {t('sources.caption', 'Repetition is not independence.')}
          </p>

          {sources.isPending ? (
            <p className="text-ink-muted">{t('common.loading', 'Loading…')}</p>
          ) : null}
          {sources.isError ? (
            <p className="text-ink-muted">
              {t('sources.error', 'Source independence could not be loaded for this story.')}
            </p>
          ) : null}

          {data ? (
            <>
              <section aria-label={t('sources.exposureSection', 'Exposure')}>
                <SectionHeading>{t('sources.exposureSection', 'Exposure')}</SectionHeading>
                <p className="mt-1 text-sm text-ink">
                  {data.exposure_label !== null
                    ? t(
                        EXPOSURE_LINES[data.exposure_label].key,
                        EXPOSURE_LINES[data.exposure_label].fallback,
                      )
                    : t('sources.exposureUnknown', 'Not yet computed')}
                </p>
                {data.marginal_gain !== null ? (
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {t('sources.marginalGain', 'Marginal information gain: {gain}', {
                      gain: data.marginal_gain.toFixed(2),
                    })}
                  </p>
                ) : null}
                {data.redundancy_classes > 0 ? (
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {t('sources.redundancyClasses', 'Redundancy classes on this topic: {count}', {
                      count: data.redundancy_classes,
                    })}
                  </p>
                ) : null}
              </section>

              <section aria-label={t('sources.sourceSection', 'Source')}>
                <SectionHeading>{t('sources.sourceSection', 'Source')}</SectionHeading>
                {data.source ? (
                  <>
                    <p className="mt-1 text-sm text-ink">{data.source.name}</p>
                    {data.source.publisher_lineage.length > 0 ? (
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {t('sources.lineage', 'Publisher lineage')}:{' '}
                        {data.source.publisher_lineage.join(' → ')}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-1 text-sm text-ink-muted">
                    {t('sources.noSource', 'The source lineage has not been mapped yet.')}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-ink-muted">
                  {t('sources.syndication', 'Confirmed syndications: {count}', {
                    count: data.confirmed_syndication_count,
                  })}
                </p>
              </section>

              {data.co_group_stories.length > 0 ? (
                <section aria-label={t('sources.sameCoverage', 'Same coverage')}>
                  <SectionHeading>{t('sources.sameCoverage', 'Same coverage')}</SectionHeading>
                  <ul className="mt-1 flex flex-col gap-1">
                    {data.co_group_stories.map((story) => (
                      <li
                        key={story.story_id}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <Link
                          to="/stories/$storyId"
                          params={{ storyId: story.story_id }}
                          className="text-sm text-primary underline"
                        >
                          {story.title}
                        </Link>
                        <span className="shrink-0 rounded border border-line px-1.5 py-px text-xs text-ink-muted">
                          {story.relationship === 'syndicated'
                            ? t('sources.syndicated', 'syndicated')
                            : t('sources.nearDuplicate', 'near-duplicate')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {data.primary_sources.length > 0 ? (
                <section aria-label={t('sources.primarySection', 'Primary sources')}>
                  <SectionHeading>{t('sources.primarySection', 'Primary sources')}</SectionHeading>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {t('sources.primaryReviewed', 'Reviewed by an evidence steward.')}
                  </p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {data.primary_sources.map((primary) => (
                      <li key={primary.url} className="truncate text-sm">
                        <a
                          href={primary.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-primary underline"
                        >
                          {primary.title ?? primary.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : null}

          {claimItems.length > 0 ? (
            <section aria-label={t('sources.claimsSection', 'Claims')}>
              <SectionHeading>{t('sources.claimsSection', 'Claims')}</SectionHeading>
              {groupIndex.size > 0 ? (
                <p className="mt-0.5 text-xs text-ink-muted">
                  {t(
                    'sources.claimsGroups',
                    'Claims sharing a lineage group are not independent confirmations.',
                  )}
                </p>
              ) : null}
              <ul className="mt-1 flex flex-col divide-y divide-line">
                {claimItems.map((claim) => {
                  const group =
                    claim.independence_group_id !== null
                      ? groupIndex.get(claim.independence_group_id)
                      : undefined;
                  return (
                    <li key={claim.claim_id} className="flex items-baseline gap-2 py-1.5">
                      <span className="grow text-sm text-ink">{claim.canonical_text}</span>
                      {group !== undefined ? (
                        <span className="shrink-0 rounded border border-line px-1.5 py-px text-xs text-ink-muted">
                          {t('sources.lineageGroup', 'lineage group {n}', { n: group })}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      </Sheet>
    </>
  );
}
