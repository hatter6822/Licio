// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Moderation reason codes (WS-A.1.2, `docs/policy/MODERATION_TAXONOMY.md`).
// This constant MIRRORS the policy document's canonical machine-readable
// enumeration — 36 core reason codes across 12 categories plus 15
// crypto-abuse codes (51 total).  WS-G `moderation_concern` contributions
// must carry one of these codes; a unit test pins the counts and namespaces
// against the ratified taxonomy so silent drift fails CI.

/** The 12 core policy categories (SPEC §18.1). */
export const MODERATION_CATEGORIES = [
  'MOD_ILLEGAL',
  'MOD_THREAT',
  'MOD_HARASS',
  'MOD_HATE',
  'MOD_CSE',
  'MOD_GRAPHIC',
  'MOD_MISINFO',
  'MOD_IMPERS',
  'MOD_SPAM',
  'MOD_PRIVACY',
  'MOD_SYNTH',
  'MOD_IP',
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

/** The 15 crypto-abuse modes (SPEC §18.5). */
export const MODERATION_CRYPTO_MODES = [
  'MOD_CRYPTO_DRAIN',
  'MOD_CRYPTO_SIG',
  'MOD_CRYPTO_IMPERS',
  'MOD_CRYPTO_BOUNTY',
  'MOD_CRYPTO_VOTEBUY',
  'MOD_CRYPTO_BRIBE',
  'MOD_CRYPTO_CAPTURE',
  'MOD_CRYPTO_SANCTION',
  'MOD_CRYPTO_PAIDHARASS',
  'MOD_CRYPTO_PAIDREPORT',
  'MOD_CRYPTO_PAIDDISINFO',
  'MOD_CRYPTO_INVEST',
  'MOD_CRYPTO_GRANTFRAUD',
  'MOD_CRYPTO_INVOICE',
  'MOD_CRYPTO_DAOREVEAL',
] as const;

/** All 51 ratified reason codes (36 core — 3 per category — + 15 crypto). */
export const MODERATION_REASON_CODES = [
  ...MODERATION_CATEGORIES.flatMap((category) => [
    `${category}_001` as const,
    `${category}_002` as const,
    `${category}_003` as const,
  ]),
  ...MODERATION_CRYPTO_MODES.map((mode) => `${mode}_001` as const),
] as const;
export type ModerationReasonCode = (typeof MODERATION_REASON_CODES)[number];

const REASON_CODE_SET: ReadonlySet<string> = new Set(MODERATION_REASON_CODES);

/** Whether a string is a ratified WS-A.1.2 reason code. */
export function isModerationReasonCode(value: string): value is ModerationReasonCode {
  return REASON_CODE_SET.has(value);
}
