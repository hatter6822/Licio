// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Where interpretations differ" (WS-H.4.3b, SPEC §10.5; SCOI-3): the
// plain-language lens-disagreement section for stories with elevated SCOI.
// No interpretation is ever presented as correct or incorrect, and the
// optional "Needs Context" framing explicitly means "communities read this
// differently" — never false, bad, or banned.

import type { StoryInterpretationsResponse } from '@licio/shared';
import { useT } from '../../../i18n/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface WhereInterpretationsDifferProps {
  data: StoryInterpretationsResponse;
}

export function WhereInterpretationsDiffer({
  data,
}: WhereInterpretationsDifferProps): React.ReactElement | null {
  const t = useT();
  if (data.interpretations.length === 0) return null;
  return (
    <section
      aria-labelledby="interpretations-heading"
      className="rounded-lg border border-edge bg-surface p-3"
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
        {data.interpretations.map((interpretation) => (
          <li
            key={`${interpretation.lens_a}~${interpretation.lens_b}`}
            className="border-s-2 border-edge ps-3"
          >
            <p className="text-sm font-medium text-ink">
              {interpretation.lens_a_name && interpretation.lens_b_name
                ? t('interpretations.betweenNamed', 'Between {a} and {b}', {
                    a: interpretation.lens_a_name,
                    b: interpretation.lens_b_name,
                  })
                : t('interpretations.between', 'Between two lenses')}
            </p>
            <p className="text-sm text-ink-muted">{interpretation.summary}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
