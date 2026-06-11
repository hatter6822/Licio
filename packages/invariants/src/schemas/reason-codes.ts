// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.1c — the versioned reason-code registry.
//
// Every InvariantOutput carries a `reason_codes` array; the values are
// validated against THIS registry, so dashboards can rely on a closed,
// reviewed vocabulary. Codes describe WHY an output is degraded or
// qualified — never user content, never an accusation. `fallback_used` and
// `degraded` are DERIVED from the codes (single source of truth).

export const REASON_CODES = [
  /** Required inputs were missing/stale; coverage below the card minimum. */
  'INSUFFICIENT_COVERAGE',
  /** A documented approximation replaced the exact method. */
  'APPROXIMATION_FALLBACK',
  /** A cheap-statistic null calibration was older than its max age. */
  'NULL_CALIBRATION_STALE',
  /** MERI fell back from the partition matroid to the similarity view. */
  'MATROID_FALLBACK',
  /** PHI used ‖H − I‖_F because the matrix log was ill-conditioned. */
  'MATRIX_LOG_FALLBACK',
  /** The MCMC sampler's effective sample size fell below threshold. */
  'SAMPLER_NONCONVERGENCE',
  /** Output requires a safety review before any consumer may act on it. */
  'SAFETY_GATE_REQUIRED',
  /** The computation exceeded its tier's latency budget and was cut off. */
  'TIMEOUT',
  /** The computation threw; the envelope is a degraded placeholder. */
  'COMPUTE_ERROR',
  /** A value was withheld to protect a below-k cohort. */
  'SUPPRESSED_K_ANONYMITY',
  /** SCOI v2: the overlap diagram itself obstructs gluing (H¹ ≠ 0). */
  'STRUCTURAL_OBSTRUCTION',
  /** The invariant ran with default config because stored config failed validation. */
  'CONFIG_REJECTED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_CODE_REGISTRY_VERSION = 1;

const REASON_CODE_SET: ReadonlySet<string> = new Set(REASON_CODES);

export function isReasonCode(value: string): value is ReasonCode {
  return REASON_CODE_SET.has(value);
}

/** Validate an array; returns the first unknown code or null. */
export function validateReasonCodes(codes: readonly string[]): string | null {
  for (const code of codes) {
    if (!isReasonCode(code)) return code;
  }
  return null;
}

/** Codes that imply the fallback path executed. */
const FALLBACK_CODES: ReadonlySet<ReasonCode> = new Set([
  'APPROXIMATION_FALLBACK',
  'MATROID_FALLBACK',
  'MATRIX_LOG_FALLBACK',
  'TIMEOUT',
  'COMPUTE_ERROR',
]);

export function fallbackUsedFrom(codes: readonly string[]): boolean {
  return codes.some((code) => isReasonCode(code) && FALLBACK_CODES.has(code));
}

/** Degraded = any reason code at all (an unqualified output carries none). */
export function degradedFrom(codes: readonly string[]): boolean {
  return codes.length > 0;
}
