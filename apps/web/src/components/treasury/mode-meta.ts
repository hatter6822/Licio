// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.1c — the display SSOT for the seven §17.4 governance lifecycle modes:
// one label + plain-language description + badge tone per mode, exhaustively
// keyed on the shared `GovernanceMode` union so adding a mode is a compile
// error here (never a silently unlabelled badge).

import type { GovernanceMode } from '@licio/shared';
import type { BadgeTone } from '../ui/Badge/index.js';

export interface GovernanceModeMeta {
  /** Short label shown in the badge. */
  readonly label: string;
  /** Plain-language description of what the mode means for members. */
  readonly description: string;
  readonly tone: BadgeTone;
  /** Whether real assets can move in this mode (drives the funds notice). */
  readonly realAssets: boolean;
}

export const GOVERNANCE_MODE_META: Readonly<Record<GovernanceMode, GovernanceModeMeta>> = {
  ordinary: {
    label: 'Ordinary',
    description: 'A regular room: no community treasury or binding on-chain governance.',
    tone: 'neutral',
    realAssets: false,
  },
  simulated: {
    label: 'Simulated governance',
    description:
      'Governance practice with play-money only. Nothing here moves real funds; the room builds its track record before any escalation.',
    tone: 'info',
    realAssets: false,
  },
  testnet: {
    label: 'Testnet',
    description:
      'Governance runs against a test network. Signatures are real, assets are worthless test tokens.',
    tone: 'info',
    realAssets: false,
  },
  capped_production: {
    label: 'Capped production',
    description:
      'Real funds within strict per-action and per-window caps. Every spend needs a passed proposal and clears a timelock.',
    tone: 'warning',
    realAssets: true,
  },
  mature_production: {
    label: 'Mature production',
    description:
      'Full production governance after an external audit. Real funds move under the ratified law-pack.',
    tone: 'success',
    realAssets: true,
  },
  frozen: {
    label: 'Frozen',
    description:
      'Governance is frozen: no proposals, votes, or fund movement until the freeze lifts.',
    tone: 'error',
    realAssets: false,
  },
  migrating: {
    label: 'Migrating',
    description: 'The treasury is migrating. Governance actions are paused until it completes.',
    tone: 'warning',
    realAssets: false,
  },
};

export function governanceModeMeta(mode: string): GovernanceModeMeta {
  const meta = (GOVERNANCE_MODE_META as Record<string, GovernanceModeMeta>)[mode];
  // Fail-visible for an unknown server mode (never crash the room page).
  return (
    meta ?? {
      label: mode,
      description: 'Unknown governance mode.',
      tone: 'neutral',
      realAssets: false,
    }
  );
}
