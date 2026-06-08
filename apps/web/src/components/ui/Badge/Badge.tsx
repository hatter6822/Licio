// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../Icon/index.js';
import type { IconName } from '../Icon/index.js';
import { type Tone, toneIcons, toneSoftClasses } from '../status.js';

export type BadgeTone = Tone | 'neutral';

export interface BadgeProps {
  /** Semantic tone (drives the soft colour + default icon). `neutral` is unthemed. */
  tone?: BadgeTone;
  /** Override the leading icon. Defaults to the tone's status icon for semantic tones. */
  icon?: IconName;
  /** Visible label. Always rendered (as `sr-only` text when `iconOnly`). */
  children: ReactNode;
  /** Show only the icon; the label is preserved for assistive tech as `sr-only`. */
  iconOnly?: boolean;
  className?: string;
}

const base =
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium leading-none';

const neutralClasses = 'bg-surface text-ink border border-line';

/** Resolve the default icon for a tone; `neutral` has no semantic icon. */
function defaultIcon(tone: BadgeTone): IconName | undefined {
  return tone === 'neutral' ? undefined : toneIcons[tone];
}

/**
 * Small status indicator (WS-B.1.4). Colour is never the sole differentiator:
 * a badge always pairs its tinted background with an icon *and* a text label
 * (kept as `sr-only` text in icon-only mode). Reuses the canonical tone
 * vocabulary from `status.ts`.
 */
export function Badge({
  tone = 'neutral',
  icon,
  children,
  iconOnly = false,
  className,
}: BadgeProps): React.ReactElement {
  const iconName = icon ?? defaultIcon(tone);
  const colorClasses = tone === 'neutral' ? neutralClasses : toneSoftClasses[tone];

  return (
    <span className={cn(base, colorClasses, className)}>
      {iconName ? <Icon name={iconName} className="size-3.5" /> : null}
      {iconOnly ? <span className="sr-only">{children}</span> : <span>{children}</span>}
    </span>
  );
}
