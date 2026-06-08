// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restricted state (WS-B.2.5). Explains, without any call-to-action, why a
// feature is unavailable to the current reader (e.g. "Governance features are
// not yet enabled"). There is deliberately NO button: offering an action the
// reader cannot take would be misleading. The `circle-info` icon is decorative
// (the heading + reason carry the meaning). Copy (title, reason) is supplied —
// and localised — by the caller. The block is a named region so assistive tech
// can locate the explanation.
import { useId } from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../Icon/index.js';

export interface RestrictedStateProps {
  /** Primary message (rendered as a heading), e.g. "Governance is unavailable". */
  title: string;
  /** Why the feature is disabled, e.g. "Governance features are not yet enabled". */
  reason: string;
  /** Heading level so the state fits its surrounding hierarchy. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/**
 * Informational placeholder for a disabled/locked feature. Purely explanatory:
 * it pairs the {@link Icon} `circle-info` glyph with a plain-text title and
 * reason and intentionally exposes no action, so the reader is never offered a
 * control that would do nothing.
 */
export function RestrictedState({
  title,
  reason,
  headingLevel = 2,
  className,
}: RestrictedStateProps): React.ReactElement {
  const titleId = useId();
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <Icon name="circle-info" className="size-10 text-ink-muted" />
      <Heading id={titleId} className="text-lg font-semibold text-ink">
        {title}
      </Heading>
      <p className="max-w-prose text-sm text-ink-muted">{reason}</p>
    </section>
  );
}
