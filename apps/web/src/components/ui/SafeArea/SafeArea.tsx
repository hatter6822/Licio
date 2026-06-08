// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ElementType, ReactNode } from 'react';
import { cn } from '../../../lib/cn.js';

export type SafeAreaSide = 'top' | 'bottom' | 'left' | 'right';

export interface SafeAreaProps {
  children: ReactNode;
  /** Sides to pad for device safe areas (default top + bottom). */
  sides?: SafeAreaSide[];
  as?: ElementType;
  className?: string;
}

// Device safe areas (notch, home indicator) are PHYSICAL, so physical padding
// is correct here regardless of text direction — this is the one place we do
// not use logical properties.
const SIDE_CLASS: Record<SafeAreaSide, string> = {
  top: 'pt-[env(safe-area-inset-top)]',
  bottom: 'pb-[env(safe-area-inset-bottom)]',
  left: 'pl-[env(safe-area-inset-left)]',
  right: 'pr-[env(safe-area-inset-right)]',
};

/**
 * Applies padding for device safe areas via `env(safe-area-inset-*)`
 * (WS-B.1.5). Use it to keep content clear of notches and home indicators.
 */
export function SafeArea({
  children,
  sides = ['top', 'bottom'],
  as,
  className,
}: SafeAreaProps): React.ReactElement {
  const Component = (as ?? 'div') as ElementType;
  const sideClasses = sides.map((side) => SIDE_CLASS[side]).join(' ');
  return <Component className={cn(sideClasses, className)}>{children}</Component>;
}
