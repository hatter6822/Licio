// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SVGProps } from 'react';
import { cn } from '../../../lib/cn.js';
import { type IconName, iconPaths } from './icons.js';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'title'> {
  /** Which icon to render (from the inline-SVG registry). */
  name: IconName;
  /**
   * Accessible name. Provide it when the icon conveys meaning on its own
   * (the SVG becomes `role="img"` with a `<title>`); omit it for decorative
   * icons that sit beside a text label (the SVG is `aria-hidden`).
   */
  title?: string;
}

/**
 * Inline-SVG icon (WS-B.1.1f). Inherits `currentColor`, renders with no
 * external request, and is decorative by default — pass `title` to expose an
 * accessible name. Size is controlled with Tailwind size utilities via
 * `className` (default `size-5` = 20px) rather than inline styles.
 */
export function Icon({ name, title, className, ...rest }: IconProps): React.ReactElement {
  const decorative = title === undefined;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('inline-block size-5 shrink-0', className)}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : 'img'}
      focusable={false}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {iconPaths[name]}
    </svg>
  );
}
