// SPDX-License-Identifier: AGPL-3.0-or-later
import { cn } from '../../../lib/cn.js';

export interface BrandLogoProps {
  /** Accessible name announced for the brand mark. Defaults to "Licio". */
  label?: string;
  /**
   * Sizing/positioning utilities for the wrapper (set a height, e.g. `h-12`).
   * The mark fills the wrapper height and keeps its square aspect ratio.
   */
  className?: string;
  /** Eager-load (above-the-fold brand chrome). Defaults to lazy. */
  priority?: boolean;
}

/**
 * The Licio brand lockup — the woven "fabric" mark + the wordmark (WS-B fabric
 * theme). Theme-adaptive: the dark-ink mark (`light_*`) shows on light surfaces
 * and the white mark (`dark_*`) on dark surfaces, matching the ACTIVE colour
 * mode exactly. The swap is CSS-only (see `.brand-logo__img--*` in app.css) and
 * mirrors the token layer's resolution, so it honours both the system
 * `prefers-color-scheme` and the manual `data-theme` toggle without JS.
 *
 * Accessibility: a single `role="img"` wrapper carries the name; both raster
 * variants are decorative (`alt=""`, `aria-hidden`) and only the theme-matched
 * one is ever rendered (`display:block`), so there is no double announcement.
 */
export function BrandLogo({
  label = 'Licio',
  className,
  priority = false,
}: BrandLogoProps): React.ReactElement {
  const loading = priority ? 'eager' : 'lazy';
  const imgClass = 'brand-logo__img h-full w-auto select-none';
  return (
    <span role="img" aria-label={label} className={cn('brand-logo inline-flex h-10', className)}>
      <img
        src="/assets/light_192.png"
        alt=""
        aria-hidden="true"
        width={192}
        height={192}
        loading={loading}
        decoding="async"
        draggable={false}
        className={cn(imgClass, 'brand-logo__img--light')}
      />
      <img
        src="/assets/dark_192.png"
        alt=""
        aria-hidden="true"
        width={192}
        height={192}
        loading={loading}
        decoding="async"
        draggable={false}
        className={cn(imgClass, 'brand-logo__img--dark')}
      />
    </span>
  );
}
