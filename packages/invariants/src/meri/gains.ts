// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MERI marginal-exposure-gain feature and user-facing labels
// (WS-H.2.1a/WS-H.2.2c/WS-H.2.3a, SPEC §7.5/§7.6).
//
// The §7.5 pseudo-code, implemented exactly and in order:
//
//   function marginal_exposure_gain(candidate x, current feed S):
//       if duplicate_url(x, S):                 return 0
//       if same_claim_same_source_lineage(x,S): return epsilon
//       if adds_new_evidence_basis(x, S):       return high_gain
//       if adds_new_lens_without_misinfo(x, S): return medium_gain
//       return rank(S union {x}) - rank(S)
//
// The returned value is a RANKING FEATURE (the diminishing-returns input
// WS-I will consume once promoted); the MERI invariant score itself is the
// pure normalized matroid rank from `matroid.ts`. Labels never imply that
// repetition equals truth (§7.6) — the mapping is category → descriptive
// exposure label only.

import { type MeriExposure, marginalRankGain, type PartitionMatroid } from './matroid.js';

export interface MeriGainConfig {
  /** Near-zero gain acknowledging an extra syndicated copy exists. */
  epsilon: number;
  /** Gain for an exposure adding a new primary-evidence basis. */
  highGain: number;
  /** Gain for a new non-misleading lens/frame. */
  mediumGain: number;
}

export const DEFAULT_MERI_GAIN_CONFIG: MeriGainConfig = {
  epsilon: 0.01,
  highGain: 1,
  mediumGain: 0.5,
};

/** Validates a gain config; returns a problem string or null. */
export function validateMeriGainConfig(config: MeriGainConfig): string | null {
  const { epsilon, highGain, mediumGain } = config;
  if (![epsilon, highGain, mediumGain].every((v) => Number.isFinite(v) && v >= 0)) {
    return 'MERI gains must be non-negative finite numbers';
  }
  if (!(epsilon < mediumGain && mediumGain < highGain)) {
    return 'MERI gains must satisfy epsilon < mediumGain < highGain';
  }
  if (epsilon <= 0) return 'epsilon must be > 0 (it acknowledges the source exists)';
  return null;
}

/** Candidate features the gain function consumes beyond the matroid groups. */
export interface MeriGainCandidate extends MeriExposure {
  /** Claim-content group (same group ⇒ same material claim). */
  claimGroupId?: string | null | undefined;
  /** Semantic-frame/lens cluster id, when embedded. */
  framingGroupId?: string | null | undefined;
  /** True when safety/quality classifiers mark the frame misleading. */
  misleading?: boolean | undefined;
}

export type MeriGainCategory =
  | 'duplicate'
  | 'same_claim_new_source'
  | 'new_evidence'
  | 'new_lens'
  | 'rank_gain'
  | 'redundant';

export interface MeriGainResult {
  gain: number;
  category: MeriGainCategory;
}

/**
 * The §7.5 gain, computed against the CURRENT selection `S` (an ordered
 * prefix of the candidate list during greedy evaluation).
 */
export function marginalExposureGain(
  candidate: MeriGainCandidate,
  selection: readonly MeriGainCandidate[],
  matroid: PartitionMatroid,
  config: MeriGainConfig = DEFAULT_MERI_GAIN_CONFIG,
): MeriGainResult {
  // 1. duplicate_url(x, S) → 0: exact duplicates never inflate rank (MERI-1).
  if (selection.some((s) => s.urlGroupId === candidate.urlGroupId)) {
    return { gain: 0, category: 'duplicate' };
  }
  // 2. same claim + same source lineage → epsilon.
  if (
    candidate.claimGroupId &&
    candidate.sourceLineageGroupId &&
    selection.some(
      (s) =>
        s.claimGroupId === candidate.claimGroupId &&
        s.sourceLineageGroupId === candidate.sourceLineageGroupId,
    )
  ) {
    return { gain: config.epsilon, category: 'same_claim_new_source' };
  }
  // 3. adds a new primary-evidence basis → high gain (MERI-2).
  if (
    candidate.evidenceGroupId &&
    !selection.some((s) => s.evidenceGroupId === candidate.evidenceGroupId)
  ) {
    return { gain: config.highGain, category: 'new_evidence' };
  }
  // 4. adds a new lens without misinformation → medium gain.
  if (
    candidate.framingGroupId &&
    candidate.misleading !== true &&
    !selection.some((s) => s.framingGroupId === candidate.framingGroupId)
  ) {
    return { gain: config.mediumGain, category: 'new_lens' };
  }
  // 5. fall back to the exact marginal matroid rank gain (0 or 1).
  const rankGain = marginalRankGain(
    matroid,
    selection.map((s) => s.id),
    candidate.id,
  );
  return rankGain > 0
    ? { gain: rankGain, category: 'rank_gain' }
    : { gain: 0, category: 'redundant' };
}

/**
 * User-facing exposure labels (SPEC §7.6; WS-H.2.3a). `duplicate_context`
 * is shown only in topic-page lineage, never on feed cards.
 */
export const MERI_EXPOSURE_LABELS = [
  'independent_source',
  'new_angle',
  'same_claim_new_evidence',
  'duplicate_context',
] as const;
export type MeriExposureLabel = (typeof MERI_EXPOSURE_LABELS)[number];

/** Gain category → label. None of the labels implies truth-by-repetition. */
export function exposureLabelForCategory(category: MeriGainCategory): MeriExposureLabel | null {
  switch (category) {
    case 'new_evidence':
      return 'independent_source';
    case 'new_lens':
      return 'new_angle';
    case 'same_claim_new_source':
      return 'same_claim_new_evidence';
    case 'duplicate':
    case 'redundant':
      return 'duplicate_context';
    case 'rank_gain':
      return 'independent_source';
    default:
      return null;
  }
}
