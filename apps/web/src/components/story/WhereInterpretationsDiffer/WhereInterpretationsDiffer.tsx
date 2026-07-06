// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Where interpretations differ" (WS-H.4.3b, SPEC §10.5; SCOI-3): the
// plain-language lens-disagreement section for stories with elevated SCOI.
// No interpretation is ever presented as correct or incorrect, and the
// optional "Needs Context" framing explicitly means "communities read this
// differently" — never false, bad, or banned.

import type { StoryInterpretationsResponse } from '@licio/shared';
import { useRecordContextView } from '../../../hooks/useRecordContextView.js';
import { useT } from '../../../i18n/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface WhereInterpretationsDifferProps {
  data: StoryInterpretationsResponse;
  /** Story id for the §5.3 context-open signal (recorded only when the section
   *  actually renders — see the ref below). */
  storyId: string;
}

/** Plain-language band for the [0,1] divergence magnitude (WS-H.4.3b). Purely
 *  descriptive of how far two readings differ — never a correctness judgment. */
function disagreementBand(value: number): string | null {
  if (value >= 0.67) return 'Strong difference';
  if (value >= 0.34) return 'Moderate difference';
  if (value > 0) return 'Slight difference';
  return null;
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
        <Icon name="circle-question" className="size-4" />
        {t('interpretations.title', 'Where interpretations differ')}
      </h2>
      {data.needs_context ? (
        <p className="mt-1 text-xs text-ink-muted">
          {t(
            'interpretations.needsContext',
            'Communities are reading this story differently. That means it benefits from context — not that it is false or banned.',
          )}
        </p>
      ) : null}
      <ul className="mt-3 flex flex-col gap-2">
        {data.interpretations.map((interpretation) => {
          const band = disagreementBand(interpretation.disagreement);
          return (
            <li
              key={`${interpretation.lens_a}~${interpretation.lens_b}`}
              className="border-s-2 border-line ps-3"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="text-sm font-medium text-ink">
                  {interpretation.lens_a_name && interpretation.lens_b_name
                    ? t('interpretations.betweenNamed', 'Between {a} and {b}', {
                        a: interpretation.lens_a_name,
                        b: interpretation.lens_b_name,
                      })
                    : t('interpretations.between', 'Between two lenses')}
                </p>
                {band ? (
                  <span className="rounded border border-line px-1.5 py-px text-xs text-ink-muted">
                    {band}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-ink-muted">{interpretation.summary}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
