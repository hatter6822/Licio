// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.1a feature vector + WS-I.1.1a/d candidate + WS-I.2.5a decision-log
// schema suites: strict closure (unknown fields rejected), denied-field
// rejection at validation, required-field enforcement, version traceability,
// privacy-bucket shape, and the field-name snapshot that flags unreviewed
// schema additions.

import { describe, expect, it } from 'vitest';
import { candidatePoolSchema, candidateSchema, mergeCandidates } from '../schemas/candidate.js';
import {
  rankingDecisionLogSchema,
  retentionDeadline,
  userPrivacyBucketSchema,
} from '../schemas/decision-log.js';
import { featureSchemaFieldNames, validateFeatureVector } from '../schemas/feature-vector.js';
import { makeCandidate, makeFeatures, PROFILE, T0, uuidOf } from './fixtures.js';

describe('WS-I.2.1a feature vector schema', () => {
  it('accepts a fully-populated valid vector', () => {
    const result = validateFeatureVector(makeFeatures(1));
    expect(result.ok).toBe(true);
  });

  it('rejects unknown fields (strict-mode closure)', () => {
    const result = validateFeatureVector({ ...makeFeatures(1), surprise_field: 1 });
    expect(result.ok).toBe(false);
  });

  it('rejects denied financial fields AS denied (defense in depth)', () => {
    const result = validateFeatureVector({ ...makeFeatures(1), wallet_balance: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denied).toBe(true);
      expect(result.problems[0]).toContain('wallet_balance');
    }
  });

  it('rejects missing required metadata', () => {
    const { item_id: _dropped, ...rest } = makeFeatures(1);
    const result = validateFeatureVector(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denied).toBe(false);
  });

  it('rejects a vector without invariant_versions (WS-I.2.1c)', () => {
    const { invariant_versions: _dropped, ...rest } = makeFeatures(1);
    expect(validateFeatureVector(rest).ok).toBe(false);
  });

  it('carries the WS-I.2.1c version entries with config hash', () => {
    const vector = makeFeatures(1, {
      invariant_versions: {
        MFCI: {
          version_string: '1.0.0',
          computation_timestamp: new Date(T0).toISOString(),
          config_hash: 'abc123',
        },
      },
    });
    const result = validateFeatureVector(vector);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vector.invariant_versions['MFCI']?.config_hash).toBe('abc123');
    }
  });

  it('field-name snapshot: additions must be reviewed (WS-I.2.1a)', () => {
    expect(featureSchemaFieldNames().sort()).toEqual(
      [
        'active_attention',
        'braid_agenda_entropy',
        'cid_defect',
        'constructive_participation',
        'context_coherence_gain',
        'coordination_penalty',
        'created_at',
        'dispute_penalty',
        // WS-T — reviewed addition: 1 when a sourced-correction debate UPHELD the
        // story (`validated`), driving the modest `disputeValidationBoost`.
        'dispute_validation',
        'duplicate_cluster_id',
        'exposure_independence',
        'feature_version',
        'freshness_decay',
        'gwei_cohort_disparity',
        'harmful_tension_risk',
        'hodge_harmonic_tension',
        'invariant_versions',
        'item_id',
        'item_type',
        'meri_rank',
        'mfci_risk_state',
        'mfci_score',
        'path_signature_wellbeing',
        'redundancy_penalty',
        'reeb_landscape_basin_id',
        'revision',
        'room_id',
        'scoi_level',
        // WS-I sensitive-content review-gate: per-item WS-F sensitivity labels
        // drive the conservative curve + the §11.5 penalty (content sensitivity
        // is a label, not a topic).
        'sensitivity_labels',
        'source_evidence_completeness',
        'source_id',
        'source_reliability',
        'topic_ids',
        'topic_relevance',
        'tropical_cascade_rank',
        'updated_at',
        // WS-Q.4.3 — reviewed addition: a NON-SCORING eligibility/audit field
        // (the scoring stage ignores it; the distribution gate reads it).
        'visibility',
      ].sort(),
    );
  });
});

describe('WS-I.1.1a/d candidate schema + merge', () => {
  it('accepts every organic source type and rejects unknown ones', () => {
    expect(candidateSchema.safeParse(makeCandidate(1)).success).toBe(true);
    expect(
      candidateSchema.safeParse({ ...makeCandidate(1), source_type: 'sponsored' }).success,
    ).toBe(false);
  });

  it('is strict: a financial field cannot ride a candidate', () => {
    expect(candidateSchema.safeParse({ ...makeCandidate(1), payment_amount: 3 }).success).toBe(
      false,
    );
  });

  it('merge dedupes by item id, merges origins, keeps the max score', () => {
    const a = makeCandidate(1, { retrieval_score: 0.3, retrieval_origins: ['origin_a'] });
    const b = makeCandidate(1, { retrieval_score: 0.8, retrieval_origins: ['origin_b'] });
    const merged = mergeCandidates([[a], [b]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.retrieval_score).toBe(0.8);
    expect(merged[0]?.retrieval_origins).toEqual(['origin_b', 'origin_a']);
  });

  it('merge ordering is deterministic (score desc, freshness desc, id)', () => {
    const batch = [makeCandidate(3), makeCandidate(1), makeCandidate(2)];
    const a = mergeCandidates([batch]).map((c) => c.item_id);
    const b = mergeCandidates([[...batch].reverse()]).map((c) => c.item_id);
    expect(a).toEqual(b);
  });

  it('pool validation rejects an invalid member', () => {
    expect(() => candidatePoolSchema.parse([makeCandidate(1), { item_id: 'nope' }])).toThrow();
  });
});

describe('WS-I.2.5a decision-log schema', () => {
  const minimalLog = {
    request_id: uuidOf(50),
    surface: 'front_page' as const,
    user_privacy_bucket: 'bucket:a1',
    candidate_ids: [uuidOf(1)],
    selected_ids: [],
    score_components: {},
    feature_revisions: {},
    invariant_versions: {},
    constraints_applied: [],
    safety_exclusions: [],
    quota_outcomes: [],
    explanation_ids: {},
    experiment_ids: [],
    timestamp: new Date(T0).toISOString(),
    profile_id: PROFILE.profile_id,
    profile_version: PROFILE.profile_version,
    feature_version: 1,
    fallback: true,
    fallback_reason: 'kill_switch' as const,
    replay_inputs: null,
    retain_until: retentionDeadline(new Date(T0).toISOString(), 180),
  };

  it('accepts a valid fallback log', () => {
    expect(rankingDecisionLogSchema.safeParse(minimalLog).success).toBe(true);
  });

  it('rejects a raw-uuid privacy bucket (never an identifier)', () => {
    expect(userPrivacyBucketSchema.safeParse(uuidOf(7)).success).toBe(false);
    expect(userPrivacyBucketSchema.safeParse('anonymous').success).toBe(true);
    expect(userPrivacyBucketSchema.safeParse('bucket:3f').success).toBe(true);
    expect(userPrivacyBucketSchema.safeParse('bucket:xyz').success).toBe(false);
  });

  it('rejects a ranked log whose selected item lacks score components', () => {
    const bad = {
      ...minimalLog,
      fallback: false,
      fallback_reason: null,
      selected_ids: [uuidOf(1)],
    };
    expect(rankingDecisionLogSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { request_id: _dropped, ...rest } = minimalLog;
    expect(rankingDecisionLogSchema.safeParse(rest).success).toBe(false);
  });

  it('clamps the retention deadline to the §22.4 window', () => {
    const base = new Date(T0).toISOString();
    const day = 24 * 60 * 60 * 1000;
    expect(Date.parse(retentionDeadline(base, 10))).toBe(T0 + 180 * day);
    expect(Date.parse(retentionDeadline(base, 9999))).toBe(T0 + 365 * day);
    expect(Date.parse(retentionDeadline(base, 200))).toBe(T0 + 200 * day);
  });
});
