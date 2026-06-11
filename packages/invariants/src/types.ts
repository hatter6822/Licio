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

export interface InvariantVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface InvariantOutput {
  type: InvariantType;
  version: InvariantVersion;
  confidence: number;
  coverage: number;
  reasonCodes: string[];
  fallbackBehavior: 'degrade-gracefully' | 'fail-open' | 'fail-closed';
  timestamp: string;
  metadata?: Record<string, unknown>;
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

/** The WS-H.1.1c envelope every emitted output carries. */
export interface InvariantOutputEnvelope {
  score_vector: Record<string, unknown>;
  confidence: number;
  coverage: number;
  reason_codes: string[];
  fallback_used: boolean;
  version: string;
}
