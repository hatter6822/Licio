// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared deterministic fixtures for the @licio/ranking unit suites.

import type { RankingRequestContext } from '../pipeline.js';
import type { Candidate } from '../schemas/candidate.js';
import { FEATURE_SCHEMA_VERSION, type FeatureVector } from '../schemas/feature-vector.js';
import { EVERGREEN_PROFILE, type RankingProfileConfig } from '../schemas/profile.js';

export const T0 = Date.parse('2026-06-10T12:00:00.000Z');

export function uuidOf(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function makeCandidate(n: number, partial: Partial<Candidate> = {}): Candidate {
  return {
    item_id: uuidOf(n),
    item_type: 'story',
    source_type: 'global',
    room_id: null,
    visibility: 'public',
    topic_ids: ['civics'],
    source_id: uuidOf(9000 + n),
    freshness_timestamp: new Date(T0 - n * 3_600_000).toISOString(),
    retrieval_score: 0.5,
    retrieval_origins: ['global_pwatt_v1'],
    bridge_context: null,
    ...partial,
  };
}

export function makeFeatures(n: number, partial: Partial<FeatureVector> = {}): FeatureVector {
  return {
    item_id: uuidOf(n),
    item_type: 'story',
    room_id: null,
    visibility: 'public',
    topic_ids: ['civics'],
    source_id: uuidOf(9000 + n),
    created_at: new Date(T0 - n * 3_600_000).toISOString(),
    feature_version: FEATURE_SCHEMA_VERSION,
    revision: 0,
    invariant_versions: {},
    updated_at: new Date(T0).toISOString(),
    active_attention: 0.5,
    constructive_participation: 0.5,
    exposure_independence: 0.5,
    source_evidence_completeness: 0.5,
    context_coherence_gain: 0.5,
    freshness_decay: 0.5,
    source_reliability: 0.5,
    ...partial,
  };
}

export function makeContext(partial: Partial<RankingRequestContext> = {}): RankingRequestContext {
  return {
    surface: 'front_page',
    surfaceRoomId: null,
    nowMs: T0,
    topicRelevanceByItem: null,
    userPhiRisk: null,
    sensitiveTopicIds: new Set(['self-harm']),
    maxSourceSharePctOverride: null,
    lensByItem: null,
    ...partial,
  };
}

export const PROFILE: RankingProfileConfig = EVERGREEN_PROFILE;
