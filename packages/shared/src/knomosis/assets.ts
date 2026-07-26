// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L/WS-M — the SINGLE asset registry for Knomosis-carried assets: minor-unit
// decimals per accepted asset code, shared by the server (treasury validation,
// human summaries) and the client (deposit entry, preview display) so the two
// surfaces can never disagree about what "1.50 USDC" means.  Pure string math —
// amounts are exact decimal strings end to end, never IEEE floats.

/**
 * The simulated asset ledger prefix — fake assets are ALWAYS SIM-* (WS-L.4.1c).
 *
 * Owned HERE, with the rest of the asset vocabulary, and spelled ONCE: the whole
 * point of `SIM-` is that a simulated balance can never be mistaken for a real
 * asset symbol, and a guarantee restated in three places is one that can be
 * changed in two.  The wire validator (`simAssetCodeSchema`) and the runtime
 * config's default and validator all derive from this.
 */
export const SIM_ASSET_PREFIX = 'SIM-' as const;

/** The simulated asset the demo treasury bootstraps with (WS-L.4.1c). */
export const DEFAULT_SIM_ASSET = `${SIM_ASSET_PREFIX}USDC` as const;

/** Minor-unit decimals per accepted asset (fail-closed: absent ⇒ rejected). */
export const KNOMOSIS_ASSET_DECIMALS: Readonly<Record<string, number>> = {
  USDC: 6,
  [DEFAULT_SIM_ASSET]: 6,
};

/**
 * Convert a human-entered decimal amount (e.g. `"1.5"`) into an EXACT
 * minor-unit integer string (`"1500000"` at 6 decimals).  Returns null on
 * anything malformed, non-positive, or with more fractional digits than the
 * asset carries — excess precision is a rejection, never a silent rounding.
 */
export function parseHumanAmountToMinorUnits(value: string, decimals: number): string | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const match = /^(\d{1,40})(?:\.(\d{1,36}))?$/.exec(value.trim());
  if (match === null) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return null;
  const minor = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  if (!/^[1-9]\d*$/.test(minor)) return null; // zero and malformed both reject
  return minor;
}
