// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Where interpretations differ" (WS-H.4.3b, SPEC §10.5; SCOI-3): the
// plain-language lens-disagreement section for stories with elevated SCOI.
// No interpretation is ever presented as correct or incorrect, and the
// optional "Needs Context" framing explicitly means "communities read this
// differently" — never false, bad, or banned.
//
// Density (WS-B): the wire carries up to 16 lens pairs (§invariants-api), so the
// section is built to stay compact when several differ. Entries sort by
// divergence magnitude (strongest first), render as a tight divided list rather
// than card-per-entry chrome, and everything past the first few collapses behind
// a native <details> disclosure so a long lens map never dominates the page.

import type { StoryInterpretation, StoryInterpretationsResponse } from '@licio/shared';
import { useRecordContextView } from '../../../hooks/useRecordContextView.js';
import { useT } from '../../../i18n/index.js';
import { ProgressiveDisclosure } from '../../cognitive/ProgressiveDisclosure/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface WhereInterpretationsDifferProps {
  data: StoryInterpretationsResponse;
  /** Story id for the §5.3 context-open signal (recorded only when the section
   *  actually renders — see the ref below). */
  storyId: string;
}

/** How many differences stay expanded inline before the rest collapse behind the
 *  disclosure. The strongest (highest-divergence) pairs are always the visible
 *  ones after the sort below. */
const INLINE_VISIBLE = 3;

/** Plain-language band for the [0,1] divergence magnitude (WS-H.4.3b). Purely
 *  descriptive of how far two readings differ — never a correctness judgment. */
function disagreementBand(value: number): string | null {
  if (value >= 0.67) return 'Strong difference';
  if (value >= 0.34) return 'Moderate difference';
  if (value > 0) return 'Slight difference';
  return null;
}

/** One lens-pair row: names + the divergence band, then the plain-language
 *  summary. A tight two-line block (no per-entry card/rail) so many pairs stack
 *  densely; the list divider separates them. */
function InterpretationRow({
  interpretation,
}: {
  interpretation: StoryInterpretation;
}): React.ReactElement {
  const t = useT();
  const band = disagreementBand(interpretation.disagreement);
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-ink">
          {interpretation.lens_a_name && interpretation.lens_b_name
            ? t('interpretations.betweenNamed', 'Between {a} and {b}', {
                a: interpretation.lens_a_name,
                b: interpretation.lens_b_name,
              })
            : t('interpretations.between', 'Between two lenses')}
        </p>
        {band ? (
          <span className="shrink-0 rounded border border-line px-1.5 py-px text-xs text-ink-muted">
            {band}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-sm text-ink-muted">{interpretation.summary}</p>
    </li>
  );
}

export function WhereInterpretationsDiffer({
  data,
  storyId,
}: WhereInterpretationsDifferProps): React.ReactElement | null {
  const t = useT();
  // §5.3 context-open signal: the ref is attached to the section ONLY on the
  // render paths below — when there are interpretations to show. An empty
  // result returns null before the ref is ever attached, so a reader dwelling
  // near a story with NO context section can never emit a false `context_opened`
  // (a zero-height observer target would otherwise report intersecting).
  const contextViewRef = useRecordContextView(storyId, true);
  if (data.interpretations.length === 0) return null;

  // Surface the sharpest differences first (a copy — never mutate the query
  // cache's array). Ordering is presentational only; no reading is "more
  // correct" than another. The tie order is the wire order.
  const ordered = [...data.interpretations].sort((a, b) => b.disagreement - a.disagreement);
  const inline = ordered.slice(0, INLINE_VISIBLE);
  const hidden = ordered.slice(INLINE_VISIBLE);

  return (
    <section
      ref={contextViewRef}
      aria-labelledby="interpretations-heading"
      className="rounded-lg border border-line bg-surface p-3"
    >
      <h2
        id="interpretations-heading"
        className="flex items-center gap-2 text-sm font-medium text-ink"
      >
        <Icon name="circle-question" className="size-4 shrink-0" />
        <span>{t('interpretations.title', 'Where interpretations differ')}</span>
        {ordered.length > 1 ? (
          <span className="ms-auto shrink-0 text-xs font-normal text-ink-muted">
            {t('interpretations.count', '{count} differences', { count: ordered.length })}
          </span>
        ) : null}
      </h2>
      {data.needs_context ? (
        <p className="mt-1 text-xs text-ink-muted">
          {t(
            'interpretations.needsContext',
            'Communities are reading this story differently. That means it benefits from context — not that it is false or banned.',
          )}
        </p>
      ) : null}
      <ul className="mt-3 flex flex-col divide-y divide-line">
        {inline.map((interpretation) => (
          <InterpretationRow
            key={`${interpretation.lens_a}~${interpretation.lens_b}`}
            interpretation={interpretation}
          />
        ))}
      </ul>
      {hidden.length > 0 ? (
        <ProgressiveDisclosure
          className="mt-2"
          summary={t('interpretations.showMore', 'Show {count} more', { count: hidden.length })}
        >
          <ul className="flex flex-col divide-y divide-line">
            {hidden.map((interpretation) => (
              <InterpretationRow
                key={`${interpretation.lens_a}~${interpretation.lens_b}`}
                interpretation={interpretation}
              />
            ))}
          </ul>
        </ProgressiveDisclosure>
      ) : null}
    </section>
  );
}
