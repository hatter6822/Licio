// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MouseEvent, ReactNode } from 'react';
import { cn } from '../../../lib/cn.js';
import { raisedInteractive, raisedSurface } from '../../../lib/surfaces.js';

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

// Cards are extruded from the canvas with a soft neumorphic shadow (WS-B fabric
// theme), so each reads as a surface lifted off the page; the hairline border
// keeps a crisp edge (and the only visible boundary under forced-colors, where
// the shadow flattens). `p-4` is the default content inset (matching the rest of
// the card surfaces, e.g. StoryCard `p-4`) so children never sit flush against
// the edge.
const base = cn('block p-4', raisedSurface);

// Interactive surfaces depress into the surface on press and carry the system
// focus ring (the shared `raisedInteractive` treatment, reused by the profile /
// rooms list rows so every tappable surface reads the same and never ghosts).
const interactiveClasses = cn('text-start', raisedInteractive);

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
