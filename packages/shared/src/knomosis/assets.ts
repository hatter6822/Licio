// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L/WS-M — the SINGLE asset registry for Knomosis-carried assets: minor-unit
// decimals per accepted asset code, shared by the server (treasury validation,
// human summaries) and the client (deposit entry, preview display) so the two
// surfaces can never disagree about what "1.50 USDC" means.  Pure string math —
// amounts are exact decimal strings end to end, never IEEE floats.

/** Minor-unit decimals per accepted asset (fail-closed: absent ⇒ rejected). */
export const KNOMOSIS_ASSET_DECIMALS: Readonly<Record<string, number>> = {
  USDC: 6,
  'SIM-USDC': 6,
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
