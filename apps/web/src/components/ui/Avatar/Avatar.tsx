// SPDX-License-Identifier: AGPL-3.0-or-later
import { cn } from '../../../lib/cn.js';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  /** Image URL. When omitted, an initials fallback is rendered. */
  src?: string;
  /** Person/entity name — used for the image `alt` and the initials fallback. */
  name?: string;
  /**
   * Purely decorative (sits beside a visible name). The image gets `alt=""`
   * and the initials fallback is `aria-hidden`.
   */
  decorative?: boolean;
  size?: AvatarSize;
  className?: string;
}

const sizeClasses: Record<AvatarSize, string> = {
  sm: 'size-6 text-xs',
  md: 'size-8 text-sm',
  lg: 'size-12 text-base',
};

const base = 'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full';

/** First letters of up to two name parts, uppercased (e.g. "Ada Lovelace" → "AL"). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '';
  }
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * Avatar (WS-B.1.4). Renders an image when `src` is given, otherwise an initials
 * fallback in a tinted circle. By design it renders ONLY the image or initials —
 * never a follower count, online/popularity ring, or any applause adornment.
 */
export function Avatar({
  src,
  name,
  decorative = false,
  size = 'md',
  className,
}: AvatarProps): React.ReactElement {
  if (src !== undefined) {
    return (
      <img
        src={src}
        alt={decorative ? '' : (name ?? '')}
        className={cn(base, sizeClasses[size], 'object-cover bg-surface-strong', className)}
      />
    );
  }

  const text = name ? initials(name) : '';
  const meaningful = !decorative && name !== undefined && name !== '';

  return (
    <span
      className={cn(
        base,
        sizeClasses[size],
        'bg-surface-strong text-ink font-medium select-none',
        className,
      )}
      role={meaningful ? 'img' : undefined}
      aria-label={meaningful ? name : undefined}
      aria-hidden={meaningful ? undefined : true}
    >
      {text}
    </span>
  );
}
