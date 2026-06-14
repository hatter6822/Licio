// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MouseEvent, ReactNode } from 'react';
import { cn } from '../../../lib/cn.js';

export type CardElement = 'article' | 'section' | 'div';

export interface CardProps {
  /** Semantic wrapper for the non-interactive surface. Default `article`. */
  as?: CardElement;
  /** Make the whole surface a single focusable, activatable target. */
  interactive?: boolean;
  /** When interactive, navigate here — the entire card becomes one `<a>`. */
  href?: string;
  /** When interactive without an `href`, the entire card becomes one `<button>`. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  className?: string;
  /** Card content. The card never injects a heading; children own their hierarchy. */
  children: ReactNode;
}

// Cards are extruded from the fabric canvas with a soft neumorphic shadow (WS-B
// fabric theme); the hairline border keeps a crisp edge (and the only visible
// boundary under forced-colors, where the shadow flattens).
const base = 'block rounded-lg border border-line bg-canvas neu-raised';

// Interactive surfaces depress into the surface on press and carry the system
// focus ring. The focus ring matches the other primitives (Button/Input) for
// consistency; the shadow transition is reduced-motion-aware via the token layer.
const interactiveClasses =
  'text-start transition-shadow active:neu-pressed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * Semantic container (WS-B.1.4). Renders the chosen element (`article` by
 * default) and never forces a heading, so the children's heading hierarchy is
 * preserved. When `interactive`, the *whole* card is exactly one focusable
 * control: an `<a>` when `href` is set, otherwise a `<button>`. This avoids
 * nested-interactive (a11y) traps where a card and its inner links compete.
 */
export function Card({
  as = 'article',
  interactive = false,
  href,
  onClick,
  className,
  children,
}: CardProps): React.ReactElement {
  if (interactive && href !== undefined) {
    return (
      <a href={href} onClick={onClick} className={cn(base, interactiveClasses, className)}>
        {children}
      </a>
    );
  }

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(base, interactiveClasses, 'w-full', className)}
      >
        {children}
      </button>
    );
  }

  const Tag = as;
  return <Tag className={cn(base, className)}>{children}</Tag>;
}
