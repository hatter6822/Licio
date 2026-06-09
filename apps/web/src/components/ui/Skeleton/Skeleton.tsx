// SPDX-License-Identifier: AGPL-3.0-or-later
import { cn } from '../../../lib/cn.js';

export interface SkeletonProps {
  /** Tailwind size/shape utilities for the placeholder block(s). */
  className?: string;
  /**
   * Element to render. `span` for inline placeholders (e.g. inside a line of
   * text), `div` (default) for block placeholders.
   */
  as?: 'div' | 'span';
  /**
   * Render multiple stacked placeholder lines. The shimmer block is purely
   * decorative; mark the *container* that holds skeletons with `aria-busy`.
   */
  count?: number;
  /**
   * Decorative by default. Overridable, but a skeleton conveys no meaning on
   * its own — keep it hidden and announce loading on the busy container.
   */
  'aria-hidden'?: boolean;
}

// `animate-pulse` is neutralised under prefers-reduced-motion by the global
// base rule (styles/app.css); the static tinted block remains an acceptable
// placeholder with no motion.
const blockClasses = 'block animate-pulse rounded-md bg-surface-strong';

export function Skeleton({
  className,
  as = 'div',
  count = 1,
  'aria-hidden': ariaHidden = true,
}: SkeletonProps): React.ReactElement {
  const Tag = as;
  const lines = count > 1 ? count : 1;

  if (lines === 1) {
    return <Tag aria-hidden={ariaHidden} className={cn(blockClasses, className)} />;
  }

  return (
    <Tag
      aria-hidden={ariaHidden}
      className={cn(as === 'span' ? 'inline-flex' : 'flex', 'flex-col gap-2')}
    >
      {Array.from({ length: lines }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder lines are static and identity-less
        <span key={index} className={cn(blockClasses, className)} />
      ))}
    </Tag>
  );
}
