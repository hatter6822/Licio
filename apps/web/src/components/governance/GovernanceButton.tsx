// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The banner's circular governance affordance (WS-U §24.6) — and, for a
// signed-out reader, the sign-in that unlocks it.
//
// Two full-width buttons used to compete for the top of every room page: a
// "Governance" button in the membership action row and, for anonymous readers,
// a primary "Sign in" button beside it. Both are gone. Governance is a room-wide
// CONTEXT rather than an action on the content below it, so it belongs with
// navigation in the banner — right-justified beside search, symmetrically
// opposite the back button.
//
// ONE slot carries both states because they are the same affordance at two
// stages of the same journey: taking part in a room's governance REQUIRES an
// account (WS-U §16.6 gates every governance action on membership, and
// membership on sign-in), so for a signed-out reader the honest control in that
// slot is "sign in" — pressing it and then returning lands on the governance
// button that was always the destination.
//
// The two states are coloured to read as ONE progression rather than two
// buttons: BLUE while signed out (the action that gets you in) becoming GREEN
// once you are (the surface is now yours to use). Colour is never the only cue
// — the glyph changes with it (a door-and-arrow becomes the shield-with-check)
// and so does the accessible name.
//
// The old inline "AI agent active" badge has no room on a circle, so that
// transparency moves to the two places that carry it without one: the
// accessible name states it outright, and the shield itself GLOWS GOLD. The
// glow is a property of the mark rather than a badge beside it, which keeps the
// banner to a single clean circle; the full "governed by" view is one tap away
// in the modal this opens.
import { Link } from '@tanstack/react-router';
import { useT } from '../../i18n/index.js';
import { cn } from '../../lib/cn.js';
import { useAuthStore } from '../../stores/auth.js';
import { CircleIconButton, circleActionClass } from '../ui/CircleIconButton/index.js';
import { Icon } from '../ui/Icon/index.js';

export interface GovernanceButtonProps {
  /** Open the governance modal. Only ever called for a signed-in reader. */
  onOpen: () => void;
  /** WS-U §24.6 — an AI agent currently governs this room. Stated in the
   *  accessible name AND marked with a dot (colour is never the sole carrier). */
  agentActive?: boolean;
  /**
   * Where to return after signing in — the page this banner belongs to. A
   * plain path (`/rooms/<id>`); the login route validates it as its `redirect`
   * search param.
   */
  signInRedirect: string;
  /**
   * Whether the governance surface is reachable for THIS reader — the room's
   * tier-two content bar (WS-Q.5.3a).
   *
   * It deliberately does not gate the signed-OUT state: signing in is precisely
   * how a reader gets past that bar, so hiding the control from the reader who
   * most needs it would be the wrong failure. A signed-IN reader who still
   * cannot read the room (a private room they have not joined) gets nothing —
   * the join affordance in the page body is their next step, not this.
   */
  reachable?: boolean;
  className?: string;
}

export function GovernanceButton({
  onOpen,
  agentActive = false,
  signInRedirect,
  reachable = true,
  className,
}: GovernanceButtonProps): React.ReactElement | null {
  const t = useT();
  const authenticated = useAuthStore((state) => state.status === 'authenticated');

  if (!authenticated) {
    const label = t('room.governance.signIn', 'Sign in to take part in governance');
    return (
      // A real LINK, not a button: it navigates, so it must open in a new tab on
      // middle-click and expose its destination like any other navigation.
      <Link
        to="/login"
        search={{ redirect: signInRedirect }}
        aria-label={label}
        title={label}
        // Blue — the action that gets the reader somewhere they cannot yet go.
        className={cn(circleActionClass('primary'), className)}
      >
        <Icon name="log-in" />
      </Link>
    );
  }

  if (!reachable) return null;

  return (
    <CircleIconButton
      // `check-badge` is the shield-with-check glyph — the platform's
      // governance mark (WS-M lifecycle vocabulary).
      icon="check-badge"
      // Green — the same slot, now that the reader is through: the blue → green
      // change in place is what makes the two states read as one affordance.
      tone="success"
      label={
        agentActive
          ? t('room.governance.button.agentActive', 'Governance — AI agent active')
          : t('room.governance.button', 'Governance')
      }
      // A room under active AI governance makes the shield GLOW gold — a
      // property of the governance mark itself, so the banner keeps one clean
      // circle instead of gaining a badge. Reinforcement only: the state is
      // already in the accessible name above.
      {...(agentActive ? { iconClassName: 'text-governed glow-governed' } : {})}
      aria-haspopup="dialog"
      onClick={onOpen}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
