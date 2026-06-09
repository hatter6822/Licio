// SPDX-License-Identifier: AGPL-3.0-or-later
import { cn } from '../../../lib/cn.js';

export type SeparatorOrientation = 'horizontal' | 'vertical';

export interface SeparatorProps {
  /** Visual/semantic direction of the divider. Default `horizontal`. */
  orientation?: SeparatorOrientation;
  /**
   * Purely visual by default — a decorative separator is hidden from assistive
   * tech (`aria-hidden`). Set `decorative={false}` when the divider conveys a
   * meaningful break between groups, exposing `role="separator"` with the
   * matching `aria-orientation`.
   */
  decorative?: boolean;
  /** Extra Tailwind utilities (e.g. margins, or a custom length/thickness). */
  className?: string;
}

const base = 'shrink-0 bg-line';

const orientationClasses: Record<SeparatorOrientation, string> = {
  horizontal: 'h-px w-full',
  vertical: 'h-full w-px',
};

/**
 * Separator (WS-B.1.4). A thin divider drawn in the `line` token. Decorative by
 * default (hidden from assistive tech); when meaningful it becomes a semantic
 * `role="separator"` with an explicit `aria-orientation`.
 */
export function Separator({
  orientation = 'horizontal',
  decorative = true,
  className,
}: SeparatorProps): React.ReactElement {
  const classes = cn(base, orientationClasses[orientation], className);

  if (decorative) {
    return <div aria-hidden="true" className={classes} />;
  }

  // Native <hr> carries the implicit `separator` role; `border-0` strips the
  // browser default rule so the divider is drawn purely from the `line` token.
  return <hr aria-orientation={orientation} className={cn('border-0', classes)} />;
}
