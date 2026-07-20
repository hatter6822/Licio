// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Core invariant types (WS-H.1, SPEC §21.4/§22.1/§30.4).

/** The eleven WS-H invariant families (5 core + 6 supporting). */
export enum InvariantType {
  MERI = 'MERI',
  MFCI = 'MFCI',
  GWEI = 'GWEI',
  SCOI = 'SCOI',
  PHI = 'PHI',
  HodgeTension = 'hodge_tension',
  TropicalCascade = 'tropical_cascade',
  BraidDynamics = 'braid_dynamics',
  ReebLandscape = 'reeb_landscape',
  CounterfactualDefect = 'counterfactual_defect',
  PathSignatureWellbeing = 'path_signature_wellbeing',
}

/** All eleven type names, in registry order. */
export const INVARIANT_TYPE_NAMES = [
  InvariantType.MERI,
  InvariantType.MFCI,
  InvariantType.GWEI,
  InvariantType.SCOI,
  InvariantType.PHI,
  InvariantType.HodgeTension,
  InvariantType.TropicalCascade,
  InvariantType.BraidDynamics,
  InvariantType.ReebLandscape,
  InvariantType.CounterfactualDefect,
  InvariantType.PathSignatureWellbeing,
] as const;

/** Targets an invariant output can score (SPEC §22.1 + WS-H.1.1a). */
export const INVARIANT_TARGET_TYPES = [
  'story',
  'thread',
  'feed',
  'room',
  'cohort',
  'session',
] as const;
export type InvariantTargetType = (typeof INVARIANT_TARGET_TYPES)[number];

/**
 * Semver `{major, minor, patch}` struct.
 *
 * @deprecated The emitted/persisted shapes carry `version` as the semver
 * *text* (`string`) — see {@link InvariantOutput}, {@link InvariantOutputEnvelope},
 * and the runner/card schema. This struct is retained only for a parser that
 * splits that text; do not add it to any output row.
 */
export interface InvariantVersion {
  major: number;
  minor: number;
  patch: number;
}

/** A computation target. */
export interface InvariantTarget {
  targetType: InvariantTargetType;
  targetId: string;
}

/** A half-open computation window [start, end) as ISO instants. */
export interface InvariantTimeWindow {
  start: string;
  end: string;
}

/**
 * The single §22.1 InvariantOutput SSOT — the shape production actually emits
 * and persists. It reconciles the WS-H.1.1c {@link InvariantOutputEnvelope}
 * (score vector, confidence, coverage, reason codes, fallback indicator,
 * semver-text version) with the computation {@link InvariantTarget} and
 * {@link InvariantTimeWindow}. The apps/api persisted row type
 * (`InvariantOutputRecord`) is the storage projection of this shape.
 */
export interface InvariantOutput {
  type: InvariantType;
  target: InvariantTarget;
  window: InvariantTimeWindow;
  /** Semver text (e.g. `"1.0.0"`), matching the envelope/card schema. */
  version: string;
  /** Validated per invariant type before persist (WS-H.1.1d schemas). */
  score_vector: Record<string, unknown>;
  confidence: number;
  /** Fraction of required inputs available and fresh (WS-H.1.1c). */
  coverage: number;
  /** Registry-validated reason codes; `[]` = unqualified output. */
  reason_codes: string[];
  /** Derived from the reason codes (WS-H.1.1c). */
  fallback_used: boolean;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** The WS-H.1.1c envelope every emitted output carries. */
export interface InvariantOutputEnvelope {
  score_vector: Record<string, unknown>;
  confidence: number;
  coverage: number;
  reason_codes: string[];
  fallback_used: boolean;
  version: string;
}
