// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The circular banner action (WS-B.1.5). Page banners carry navigation, not
// content: the back button sits at the inline-start and these round icon
// buttons at the inline-end, symmetrically opposite it, so a long story title
// or room name never competes with them for the bar (the <h1> leads the page
// body instead — see PageHeader `titlePlacement`).
//
// It is a SHARED primitive rather than per-feature markup so every banner
// action is the same 48px token-sized circle with the same neumorphic lighting
// and focus ring — "symmetrically opposing" is a geometric promise, and two
// hand-rolled copies would drift.
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon, type IconName } from '../Icon/index.js';

/**
 * The colour a banner action carries.
 *
 * - `neutral` — the default: a surface-filled circle that recedes into the bar.
 *   Navigation-ish actions that are always available (search).
 * - `primary` (blue) — the action that GETS the reader somewhere they cannot
 *   currently go: signing in.
 * - `success` (green) — the state where that has already happened and the
 *   surface is theirs to use: governance.
 *
 * Blue → green in the SAME slot therefore reads as progress, not as two
 * unrelated buttons: it is one affordance before and after sign-in.
 */
export type CircleActionTone = 'neutral' | 'primary' | 'success';

/** Geometry + lighting shared by every tone (48px touch token, circular, the
 *  standard focus ring). */
const circleActionBase =
  'inline-flex h-touch w-touch shrink-0 items-center justify-center rounded-full border neu-raised-sm transition-colors active:neu-pressed-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

// Each filled tone borders in a darker shade of its OWN hue (the Button
// convention): a crisp edge that survives the neumorphic shadow flattening
// under forced-colors, never a heavy outline. Foregrounds are the verified
// `*-fg` pair of their fill, so contrast holds in both themes.
const circleActionTones: Record<CircleActionTone, string> = {
  neutral: 'border-line bg-surface text-ink-muted hover:text-ink',
  primary:
    'border-primary-active bg-primary text-primary-fg hover:bg-primary-hover active:bg-primary-active',
  success:
    'border-success-active bg-success text-success-fg hover:bg-success-hover active:bg-success-active',
};

/**
 * The circle's classes for a tone, exported so a banner action that must be a
 * LINK (the sign-in affordance, which navigates) is byte-identical to the
 * buttons beside it. Anything using it MUST also carry `aria-label` + `title`:
 * these controls are icon-only.
 */
export function circleActionClass(tone: CircleActionTone = 'neutral'): string {
  return `${circleActionBase} ${circleActionTones[tone]}`;
}

export interface CircleIconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children' | 'type'> {
  /** Accessible name AND tooltip — required: the button is icon-only, so this
   *  is its ONLY name. State the scope it acts on ("Search this room"), never
   *  just the verb. */
  label: string;
  /** The icon glyph (the WS-B.1.1f registry — no icon font, no sprite). */
  icon: IconName;
  /** Colour treatment — see CircleActionTone. Defaults to `neutral`. */
  tone?: CircleActionTone;
  /**
   * Extra classes for the GLYPH — the seam for a state treatment carried by the
   * icon itself (a colour shift, one of the `glow-*` utilities) rather than a
   * badge stuck beside it, which would break the circle.
   *
   * Decorative ONLY: the glyph has no accessible name of its own, so whatever
   * it signals MUST also be stated in `label`. A colour or a glow is never the
   * sole carrier of meaning (WCAG 1.4.1).
   */
  iconClassName?: string;
  className?: string;
}

export function CircleIconButton({
  label,
  icon,
  tone = 'neutral',
  iconClassName,
  className,
  ...rest
}: CircleIconButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn(circleActionClass(tone), className)}
    >
      <Icon name={icon} {...(iconClassName !== undefined ? { className: iconClassName } : {})} />
    </button>
  );
}
