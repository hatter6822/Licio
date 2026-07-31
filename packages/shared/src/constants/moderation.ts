// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Moderation reason codes (WS-A.1.2, `docs/policy/MODERATION_TAXONOMY.md`).
// This constant MIRRORS the policy document's canonical machine-readable
// enumeration — 36 core reason codes across 12 categories plus 15
// crypto-abuse codes (51 total).  WS-J reports and steward actions carry
// these codes; a unit test pins the counts and namespaces against the
// ratified taxonomy so silent drift fails CI.

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

// ---------------------------------------------------------------------------
// Reason-code severity / SLA / appealability metadata (WS-J).
//
// This block MIRRORS the `reason_codes[]` array of the policy document's
// canonical machine-readable enumeration (severity_default + appealable per
// code, and severity → SLA).  It is the single source WS-J's report routing
// (WS-J.1.1a/b), SLA tracking (WS-J.2.1a), and appeal eligibility (WS-J.1.3a)
// read — so a code's severity/appealability is decided in exactly one place.
// `apps/api/src/__tests__/moderation-doctrine-consistency.test.ts` parses
// MODERATION_TAXONOMY.md's canonical JSON block and asserts this map's
// severity / appealability / SLA code-for-code against it (hosted in the api
// node project because it reads the doc from disk), so any drift fails CI —
// the no-drift discipline used throughout the codebase.
// ---------------------------------------------------------------------------

/**
 * The four taxonomy severity levels (SPEC §18.3; MODERATION_TAXONOMY.md
 * "Severity levels and SLA targets").  Distinct from the WS-E pipeline's
 * `low|medium|high|critical` event scale — these are the policy/SLA levels and
 * the values the `POST /v1/reports` response and the console surface use.
 */
export const REPORT_SEVERITIES = ['minor', 'moderate', 'severe', 'critical'] as const;
export type ReportSeverity = (typeof REPORT_SEVERITIES)[number];

/** Response-SLA target per severity, in whole hours (the taxonomy SLA table). */
export const SEVERITY_SLA_HOURS: Readonly<Record<ReportSeverity, number>> = {
  minor: 72,
  moderate: 24,
  severe: 4,
  critical: 1,
};

export interface ReasonCodeMeta {
  /** Default severity drawn from the taxonomy (inherits that severity's SLA). */
  severity: ReportSeverity;
  /** Whether an enforcement action carrying this code is appealable (WS-A.1.2c).
   *  `false` only for the enumerated lawful-basis exceptions (CSAM, imminent
   *  threat, genocidal incitement, the DAO-reveal privacy override). */
  appealable: boolean;
}

/** Per-reason-code metadata; transcribed from the ratified taxonomy JSON. */
export const REASON_CODE_METADATA: Readonly<Record<ModerationReasonCode, ReasonCodeMeta>> = {
  MOD_ILLEGAL_001: { severity: 'severe', appealable: true },
  MOD_ILLEGAL_002: { severity: 'critical', appealable: true },
  MOD_ILLEGAL_003: { severity: 'severe', appealable: true },
  MOD_THREAT_001: { severity: 'critical', appealable: false },
  MOD_THREAT_002: { severity: 'critical', appealable: false },
  MOD_THREAT_003: { severity: 'severe', appealable: true },
  MOD_HARASS_001: { severity: 'moderate', appealable: true },
  MOD_HARASS_002: { severity: 'severe', appealable: true },
  MOD_HARASS_003: { severity: 'severe', appealable: true },
  MOD_HATE_001: { severity: 'moderate', appealable: true },
  MOD_HATE_002: { severity: 'severe', appealable: true },
  MOD_HATE_003: { severity: 'critical', appealable: false },
  MOD_CSE_001: { severity: 'critical', appealable: false },
  MOD_CSE_002: { severity: 'critical', appealable: false },
  MOD_CSE_003: { severity: 'critical', appealable: false },
  MOD_GRAPHIC_001: { severity: 'moderate', appealable: true },
  MOD_GRAPHIC_002: { severity: 'severe', appealable: true },
  MOD_GRAPHIC_003: { severity: 'severe', appealable: true },
  MOD_MISINFO_001: { severity: 'severe', appealable: true },
  MOD_MISINFO_002: { severity: 'severe', appealable: true },
  MOD_MISINFO_003: { severity: 'moderate', appealable: true },
  MOD_IMPERS_001: { severity: 'moderate', appealable: true },
  MOD_IMPERS_002: { severity: 'severe', appealable: true },
  MOD_IMPERS_003: { severity: 'moderate', appealable: true },
  MOD_SPAM_001: { severity: 'minor', appealable: true },
  MOD_SPAM_002: { severity: 'moderate', appealable: true },
  MOD_SPAM_003: { severity: 'severe', appealable: true },
  MOD_PRIVACY_001: { severity: 'moderate', appealable: true },
  MOD_PRIVACY_002: { severity: 'severe', appealable: true },
  MOD_PRIVACY_003: { severity: 'critical', appealable: true },
  MOD_SYNTH_001: { severity: 'minor', appealable: true },
  MOD_SYNTH_002: { severity: 'moderate', appealable: true },
  MOD_SYNTH_003: { severity: 'severe', appealable: true },
  MOD_IP_001: { severity: 'minor', appealable: true },
  MOD_IP_002: { severity: 'minor', appealable: true },
  MOD_IP_003: { severity: 'moderate', appealable: true },
  MOD_CRYPTO_DRAIN_001: { severity: 'critical', appealable: true },
  MOD_CRYPTO_SIG_001: { severity: 'severe', appealable: true },
  MOD_CRYPTO_IMPERS_001: { severity: 'severe', appealable: true },
  MOD_CRYPTO_BOUNTY_001: { severity: 'moderate', appealable: true },
  MOD_CRYPTO_VOTEBUY_001: { severity: 'severe', appealable: true },
  MOD_CRYPTO_BRIBE_001: { severity: 'severe', appealable: true },
  MOD_CRYPTO_CAPTURE_001: { severity: 'severe', appealable: true },
  MOD_CRYPTO_SANCTION_001: { severity: 'critical', appealable: true },
  MOD_CRYPTO_PAIDHARASS_001: { severity: 'severe', appealable: true },
  MOD_CRYPTO_PAIDREPORT_001: { severity: 'moderate', appealable: true },
  MOD_CRYPTO_PAIDDISINFO_001: { severity: 'severe', appealable: true },
  MOD_CRYPTO_INVEST_001: { severity: 'moderate', appealable: true },
  MOD_CRYPTO_GRANTFRAUD_001: { severity: 'severe', appealable: true },
  MOD_CRYPTO_INVOICE_001: { severity: 'severe', appealable: true },
  MOD_CRYPTO_DAOREVEAL_001: { severity: 'critical', appealable: false },
};

/**
 * Imminent-risk codes that are NOT `critical` by default but are routed to the
 * emergency path anyway (WS-J.1.1b "the explicitly enumerated imminent-risk
 * codes"): active self-harm promotion/instruction.  Credible threats, CSAM,
 * terrorism, and the privacy/sanctions critical codes are already `critical`
 * and so are included by the severity rule below.
 */
export const IMMINENT_RISK_REASON_CODES: readonly ModerationReasonCode[] = [
  'MOD_GRAPHIC_002',
  'MOD_GRAPHIC_003',
];

/**
 * The emergency reason-code set (WS-J.1.1b): exactly the codes whose default
 * severity is `critical` PLUS the enumerated imminent-risk codes.  Derived, so
 * it cannot drift from the severity metadata.
 */
export const EMERGENCY_REASON_CODES: ReadonlySet<ModerationReasonCode> = new Set([
  ...MODERATION_REASON_CODES.filter((code) => REASON_CODE_METADATA[code].severity === 'critical'),
  ...IMMINENT_RISK_REASON_CODES,
]);

/** Severity a report inherits from its reason code. */
export function reasonCodeSeverity(code: ModerationReasonCode): ReportSeverity {
  return REASON_CODE_METADATA[code].severity;
}

/** Whether an action carrying this reason code is appealable (lawful-basis aware). */
export function reasonCodeAppealable(code: ModerationReasonCode): boolean {
  return REASON_CODE_METADATA[code].appealable;
}

/** Whether a reason code routes to the emergency queue / on-call (WS-J.1.1b). */
export function isEmergencyReasonCode(code: ModerationReasonCode): boolean {
  return EMERGENCY_REASON_CODES.has(code);
}

/** SLA target (hours) for a reason code, via its inherited severity. */
export function reasonCodeSlaHours(code: ModerationReasonCode): number {
  return SEVERITY_SLA_HOURS[reasonCodeSeverity(code)];
}

/**
 * Map a taxonomy severity to the WS-E moderation-event severity scale
 * (`low|medium|high|critical`), so a report's taxonomy severity can populate
 * the `moderation.case.created` event without inventing a second SSOT.
 */
export function toEventSeverity(severity: ReportSeverity): 'low' | 'medium' | 'high' | 'critical' {
  switch (severity) {
    case 'minor':
      return 'low';
    case 'moderate':
      return 'medium';
    case 'severe':
      return 'high';
    case 'critical':
      return 'critical';
  }
}
