// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The six wallet-signed Knomosis action types (WS-L.2.4d; SPEC §17.3.2/§17.3.3),
// alone in a module that imports NOTHING.
//
// The tuple used to live in `typed-data.ts` beside the zod schema built from it,
// which made it unreachable from `scripts/knomosis-pin-checks.ts`: that gate
// helper is deliberately dependency-free (no zod, no `node:` builtins) so the
// `scripts`-rooted vitest project can unit test it, and importing `typed-data.ts`
// would have pulled zod in behind it. So the gate re-spelled the six types, and
// `knomosis-pin-config.test.ts` — named in the gate's own header as what keeps
// the two in sync — spelled them a third time while never importing the gate at
// all. Three copies, nothing binding them: a seventh action type added to the
// registry would have left the CI pin gate silently not requiring a
// reversibility statement for it.
//
// Splitting the tuple out costs the gate nothing (a relative import of a
// zero-dependency module) and makes "the same six types" true by construction
// rather than by a comment.

/** The six wallet-signed action types (WS-L.2.4d; SPEC §17.3.2/§17.3.3). */
export const KNOMOSIS_SIGNED_ACTION_TYPES = [
  'proposal_sign',
  'treasury_deposit',
  'grant_payout',
  'charter_update',
  'bounty_contribution',
  'steward_rotation',
] as const;

export type KnomosisSignedActionType = (typeof KNOMOSIS_SIGNED_ACTION_TYPES)[number];
