// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3a/b/c/d — the scoring mathematics. Exact-value checks for the §5.4
// formula, baseline monotonicity, penalty derivations (including the
// tension-without-hostility zero and the sensitive-topic strictness), the
// negative-total property, and the constraint ladder.

import { describe, expect, it } from 'vitest';
import {
  computeBaseline,
  freshnessFromAge,
  NEUTRAL_SOURCE_RELIABILITY,
  sourceReliabilityFromHistory,
  topicRelevance,
} from '../scoring/baseline.js';
import {
  evaluateItemConstraints,
  gweiDeploymentGate,
  phiDiversification,
  SHADOW_CONSTRAINT_ENFORCEMENT,
} from '../scoring/constraints.js';
import {
  computePenalties,
  coordinationInput,
  disputeOrderingSink,
  harmfulTensionInput,
  MFCI_RISK_PENALTY,
  SHADOW_ENFORCEMENT,
} from '../scoring/penalties.js';
import { computePositiveScore } from '../scoring/pwatt.js';
import { makeFeatures, PROFILE } from './fixtures.js';

const FULL_ENFORCEMENT = { mfci: true, phi: true, hodge: true, meri: true, tropical: true };

describe('WS-T disputeOrderingSink', () => {
  it('is 0 for a non-disputed item (absent or zero signal)', () => {
    expect(disputeOrderingSink({}, PROFILE)).toBe(0);
    expect(disputeOrderingSink({ dispute_penalty: 0 }, PROFILE)).toBe(0);
  });

  it('dominates the whole non-sink score span for a disputed item', () => {
    const sink = disputeOrderingSink({ dispute_penalty: 1 }, PROFILE);
    // Max positive is 2 (baseline ≤ 1 + convex ≤ 1); the sink must exceed the
    // full span (positive + every penalty coefficient) so it always bottoms out.
    const { pM, pT, pR, pD } = PROFILE.penalties;
    expect(sink).toBeGreaterThan(2 + pM + pT + pR + (pD ?? 1));
  });

  it('falls back to pD = 1 when the profile omits the dispute coefficient', () => {
    const noPd = { ...PROFILE, penalties: { pM: 1, pT: 0.75, pR: 0.5 } };
    expect(disputeOrderingSink({ dispute_penalty: 1 }, noPd)).toBe(2 + 1 + 0.75 + 0.5 + 1 + 1);
  });
});

describe('WS-I.2.3d baseline', () => {
  it('freshness decays exponentially with the half-life', () => {
    const halfLife = 6;
    expect(freshnessFromAge(0, halfLife)).toBe(1);
    expect(freshnessFromAge(6 * 3_600_000, halfLife)).toBeCloseTo(0.5, 12);
    expect(freshnessFromAge(12 * 3_600_000, halfLife)).toBeCloseTo(0.25, 12);
  });

  it('newer items earn a strictly higher baseline (all else equal)', () => {
    const newer = computeBaseline({
      freshnessDecay: freshnessFromAge(1 * 3_600_000, 6),
      sourceReliability: 0.5,
      topicRelevance: undefined,
      personalizationEnabled: false,
    });
    const older = computeBaseline({
      freshnessDecay: freshnessFromAge(20 * 3_600_000, 6),
      sourceReliability: 0.5,
      topicRelevance: undefined,
      personalizationEnabled: false,
    });
    expect(newer.value).toBeGreaterThan(older.value);
  });

  it('a brand-new item with no participation has a NONZERO baseline', () => {
    const coldStart = computeBaseline({
      freshnessDecay: 1,
      sourceReliability: undefined,
      topicRelevance: undefined,
      personalizationEnabled: false,
    });
    expect(coldStart.value).toBeGreaterThan(0);
    expect(coldStart.source_reliability).toBe(NEUTRAL_SOURCE_RELIABILITY);
  });

  it('personalization OFF excludes relevance and renormalizes (no deflation)', () => {
    const off = computeBaseline({
      freshnessDecay: 0.8,
      sourceReliability: 0.6,
      topicRelevance: 1,
      personalizationEnabled: false,
    });
    expect(off.topic_relevance).toBeNull();
    // (0.5·0.8 + 0.3·0.6) / 0.8 = 0.725
    expect(off.value).toBeCloseTo(0.725, 12);
    const on = computeBaseline({
      freshnessDecay: 0.8,
      sourceReliability: 0.6,
      topicRelevance: 1,
      personalizationEnabled: true,
    });
    // 0.5·0.8 + 0.3·0.6 + 0.2·1 = 0.78
    expect(on.value).toBeCloseTo(0.78, 12);
  });

  it('baseline part weights are profile-configurable (WS-I.2.3f baseline_weights)', () => {
    const breaking = { freshness: 60, reliability: 25, relevance: 15 };
    const on = computeBaseline({
      freshnessDecay: 0.8,
      sourceReliability: 0.6,
      topicRelevance: 1,
      personalizationEnabled: true,
      weights: breaking,
    });
    // (60·0.8 + 25·0.6 + 15·1)/100 = 0.78
    expect(on.value).toBeCloseTo(0.78, 12);
    const off = computeBaseline({
      freshnessDecay: 0.8,
      sourceReliability: 0.6,
      topicRelevance: 1,
      personalizationEnabled: false,
      weights: breaking,
    });
    // Renormalized over the CONFIGURED weights: (60·0.8 + 25·0.6)/85 = 0.74117…
    expect(off.value).toBeCloseTo((60 * 0.8 + 25 * 0.6) / 85, 12);
    // Omitting weights uses the shipped default — identical to passing it.
    const defaulted = computeBaseline({
      freshnessDecay: 0.8,
      sourceReliability: 0.6,
      topicRelevance: 1,
      personalizationEnabled: true,
    });
    const explicit = computeBaseline({
      freshnessDecay: 0.8,
      sourceReliability: 0.6,
      topicRelevance: 1,
      personalizationEnabled: true,
      weights: { freshness: 50, reliability: 30, relevance: 20 },
    });
    expect(defaulted.value).toBe(explicit.value);
  });

  it('topic relevance is the matched-topic fraction over the user OWN interests', () => {
    expect(topicRelevance(['a', 'b'], ['a'])).toBe(0.5);
    expect(topicRelevance(['a', 'b'], ['a', 'b', 'c'])).toBe(1);
    expect(topicRelevance([], ['a'])).toBe(0);
    expect(topicRelevance(['a'], [])).toBe(0);
  });

  it('source reliability: diversity/citations raise it; correction frequency and notes dampen GENTLY', () => {
    // Inputs are exactly the WS-F §14.3 profile aggregates (the record has
    // no acknowledgment field — frequency is the real correction signal).
    const diverse = sourceReliabilityFromHistory({
      corrections: 0,
      evidenceTypeCount: 4,
      communityNotes: 0,
      citationCount: 0,
    });
    expect(diverse).toBeGreaterThan(NEUTRAL_SOURCE_RELIABILITY);
    const cited = sourceReliabilityFromHistory({
      corrections: 0,
      evidenceTypeCount: 4,
      communityNotes: 0,
      citationCount: 8,
    });
    expect(cited).toBeGreaterThan(diverse);
    const corrected = sourceReliabilityFromHistory({
      corrections: 6,
      evidenceTypeCount: 4,
      communityNotes: 0,
      citationCount: 0,
    });
    expect(corrected).toBeLessThan(diverse);
    expect(corrected).toBeGreaterThan(0.3); // corrections dampen MILDLY (transparency virtue)
    const noted = sourceReliabilityFromHistory({
      corrections: 0,
      evidenceTypeCount: 4,
      communityNotes: 16,
      citationCount: 0,
    });
    expect(noted).toBeLessThan(diverse);
    expect(noted).toBeGreaterThan(0);
    // No history at all ⇒ exactly neutral.
    expect(
      sourceReliabilityFromHistory({
        corrections: 0,
        evidenceTypeCount: 0,
        communityNotes: 0,
        citationCount: 0,
      }),
    ).toBe(NEUTRAL_SOURCE_RELIABILITY);
    // Monotone in diversity and citations; antitone in corrections/notes.
    for (let k = 0; k < 6; k += 1) {
      const lower = sourceReliabilityFromHistory({
        corrections: 0,
        evidenceTypeCount: k,
        communityNotes: 0,
        citationCount: 0,
      });
      const higher = sourceReliabilityFromHistory({
        corrections: 0,
        evidenceTypeCount: k + 1,
        communityNotes: 0,
        citationCount: 0,
      });
      expect(higher).toBeGreaterThanOrEqual(lower);
    }
  });
});

describe('WS-I.2.3a positive PWAtt (§5.4 exactness)', () => {
  const baseline = {
    freshness_decay: 0.5,
    source_reliability: 0.5,
    topic_relevance: null,
    value: 0.5,
  };

  it('computes B + the convex combination exactly', () => {
    const features = makeFeatures(1, {
      active_attention: 1,
      constructive_participation: 0.5,
      exposure_independence: 0.2,
      source_evidence_completeness: 0,
      context_coherence_gain: 1,
    });
    const { components } = computePositiveScore(features, PROFILE, baseline);
    // evergreen weights 20/40/15/15/10:
    // (20·1 + 40·0.5 + 15·0.2 + 15·0 + 10·1)/100 = 0.53; + B 0.5 = 1.03
    expect(components.positive).toBeCloseTo(1.03, 12);
    expect(components.weights).toEqual(PROFILE.weights);
  });

  it('ABSENT components contribute zero and are reported as null (honest omission)', () => {
    const features = makeFeatures(2, {
      exposure_independence: undefined,
      context_coherence_gain: undefined,
      active_attention: 1,
      constructive_participation: 1,
      source_evidence_completeness: 1,
    });
    const { components } = computePositiveScore(features, PROFILE, baseline);
    expect(components.exposure_independence).toBeNull();
    expect(components.context_coherence_gain).toBeNull();
    // (20 + 40 + 15)/100 = 0.75; + 0.5
    expect(components.positive).toBeCloseTo(1.25, 12);
  });

  it('is total: non-finite inputs clamp to zero', () => {
    const features = makeFeatures(3, { active_attention: Number.NaN as unknown as number });
    const { components } = computePositiveScore(features, PROFILE, baseline);
    expect(components.active_attention).toBe(0);
    expect(Number.isFinite(components.positive)).toBe(true);
  });
});

describe('WS-I.2.3b penalties', () => {
  it('the MFCI risk ladder maps normal→0 … severe→1', () => {
    expect(MFCI_RISK_PENALTY).toEqual({ normal: 0, elevated: 0.25, high: 0.5, severe: 1 });
  });

  it('coordination joins MFCI and tropical by MAX, never sum', () => {
    const both = coordinationInput(
      { mfci_risk_state: 'high', tropical_cascade_rank: 0.9 },
      { mfci: true, tropical: true },
    );
    expect(both.value).toBe(0.9);
    const mfciOnly = coordinationInput(
      { mfci_risk_state: 'severe', tropical_cascade_rank: 0.2 },
      { mfci: true, tropical: true },
    );
    expect(mfciOnly.value).toBe(1);
  });

  it('coordination enforcement follows the DOMINATING evidence source', () => {
    const tropicalDominates = coordinationInput(
      { mfci_risk_state: 'elevated', tropical_cascade_rank: 0.9 },
      { mfci: true, tropical: false },
    );
    expect(tropicalDominates.enforced).toBe(false);
    const mfciDominates = coordinationInput(
      { mfci_risk_state: 'severe', tropical_cascade_rank: 0.1 },
      { mfci: true, tropical: false },
    );
    expect(mfciDominates.enforced).toBe(true);
  });

  it('an EXACT tie enforces when EITHER tied source is promoted (inclusive compare)', () => {
    // mfci 'high' maps to 0.5; tropical 0.5 ties it exactly. The tied
    // evidence equally justifies the value, so promotion of either source
    // suffices — and with both shadow, the tie never enforces.
    const tie = { mfci_risk_state: 'high' as const, tropical_cascade_rank: 0.5 };
    expect(coordinationInput(tie, { mfci: true, tropical: false }).enforced).toBe(true);
    expect(coordinationInput(tie, { mfci: false, tropical: true }).enforced).toBe(true);
    expect(coordinationInput(tie, { mfci: false, tropical: false }).enforced).toBe(false);
    expect(coordinationInput(tie, { mfci: true, tropical: true }).value).toBe(0.5);
  });

  it('pT: high harmonic tension WITHOUT hostility produces ZERO penalty', () => {
    // The Hodge contract: harmful_tension_risk ≡ 0 absent hostility. The
    // penalty reads ONLY that field — raw tension never penalizes.
    expect(harmfulTensionInput({ harmful_tension_risk: undefined })).toBe(0);
    const features = makeFeatures(4, {
      hodge_harmonic_tension: 0.95,
      harmful_tension_risk: undefined,
    });
    const penalties = computePenalties(features, PROFILE, FULL_ENFORCEMENT, {
      sensitiveTopic: false,
    });
    expect(penalties.harmful_tension.value).toBe(0);
    expect(penalties.harmful_tension.applied).toBe(0);
  });

  it('pT: high tension AND hostility produces a positive penalty', () => {
    const features = makeFeatures(5, {
      hodge_harmonic_tension: 0.95,
      harmful_tension_risk: 0.8,
    });
    const penalties = computePenalties(features, PROFILE, FULL_ENFORCEMENT, {
      sensitiveTopic: false,
    });
    expect(penalties.harmful_tension.value).toBe(0.8);
    expect(penalties.harmful_tension.applied).toBeCloseTo(0.8 * PROFILE.penalties.pT, 12);
  });

  it('all penalties are nonnegative and can drive the total below zero', () => {
    const features = makeFeatures(6, {
      mfci_risk_state: 'severe',
      harmful_tension_risk: 1,
      redundancy_penalty: 1,
      active_attention: 0.1,
      constructive_participation: 0.1,
    });
    const penalties = computePenalties(features, PROFILE, FULL_ENFORCEMENT, {
      sensitiveTopic: true,
    });
    for (const term of [penalties.coordination, penalties.harmful_tension, penalties.redundancy]) {
      expect(term.value).toBeGreaterThanOrEqual(0);
      expect(term.applied).toBeGreaterThanOrEqual(0);
    }
    const positive = computePositiveScore(features, PROFILE, {
      freshness_decay: 0.5,
      source_reliability: 0.5,
      topic_relevance: null,
      value: 0.5,
    });
    expect(positive.components.positive - penalties.total_applied).toBeLessThan(0);
  });

  it('WS-T — a corrected story is penalized, and it applies even under shadow', () => {
    const features = makeFeatures(8, { dispute_penalty: 1 });
    const coeff = PROFILE.penalties.pD ?? 1;
    const enforced = computePenalties(features, PROFILE, FULL_ENFORCEMENT, {
      sensitiveTopic: false,
    });
    expect(enforced.dispute.value).toBe(1);
    expect(enforced.dispute.applied).toBeCloseTo(coeff, 12);
    // A resolved sourced-correction debate is authoritative — no shadow invariant
    // gates it, so the dispute penalty applies even under SHADOW enforcement.
    const shadow = computePenalties(features, PROFILE, SHADOW_ENFORCEMENT, {
      sensitiveTopic: false,
    });
    expect(shadow.dispute.applied).toBeCloseTo(coeff, 12);
    // An undisputed story carries no dispute penalty.
    const clean = computePenalties(makeFeatures(9), PROFILE, FULL_ENFORCEMENT, {
      sensitiveTopic: false,
    });
    expect(clean.dispute.applied).toBe(0);
  });

  it('UNPROMOTED penalties are computed and recorded but never applied (WS-H.1.2e)', () => {
    const features = makeFeatures(7, {
      mfci_risk_state: 'severe',
      redundancy_penalty: 1,
      harmful_tension_risk: 1,
    });
    const penalties = computePenalties(features, PROFILE, SHADOW_ENFORCEMENT, {
      sensitiveTopic: false,
    });
    expect(penalties.coordination.value).toBe(1);
    expect(penalties.coordination.applied).toBe(0);
    expect(penalties.coordination.enforced).toBe(false);
    expect(penalties.total_applied).toBe(0);
  });
});

describe('WS-I.2.3c hard constraints', () => {
  const context = { surface: 'front_page' as const, crossCommunity: true };
  const FULL = { mfci: true, phi: true, scoi: true, gwei: true, meri: true };

  it('MFCI at/above the exclusion state leaves cross-community distribution', () => {
    const result = evaluateItemConstraints(
      makeFeatures(1, { mfci_risk_state: 'severe' }),
      PROFILE,
      FULL,
      context,
    );
    expect(result.feasible).toBe(false);
    expect(result.flags).toContain('mfci_cross_community_excluded');
    expect(result.flags).toContain('mfci_review_flagged');
    const application = result.applications.find(
      (a) => a.constraint === 'mfci_severe_cross_community',
    );
    expect(application?.threshold).toBe('severe');
    expect(application?.actual).toBe('severe');
  });

  it('MFCI severe is logged-but-feasible while MFCI is shadow (no hidden sanction)', () => {
    const result = evaluateItemConstraints(
      makeFeatures(1, { mfci_risk_state: 'severe' }),
      PROFILE,
      SHADOW_CONSTRAINT_ENFORCEMENT,
      context,
    );
    expect(result.feasible).toBe(true);
    expect(
      result.applications.find((a) => a.constraint === 'mfci_severe_cross_community')?.enforced,
    ).toBe(false);
  });

  it('SCOI ladder: medium ⇒ context card (always); high ⇒ reduced when promoted', () => {
    const medium = evaluateItemConstraints(
      makeFeatures(2, { scoi_level: 'medium' }),
      PROFILE,
      SHADOW_CONSTRAINT_ENFORCEMENT,
      context,
    );
    // The context card is informational — it attaches even in shadow.
    expect(medium.flags).toContain('scoi_context_card');
    expect(medium.distributionMultiplier).toBe(1);

    const high = evaluateItemConstraints(
      makeFeatures(3, { scoi_level: 'high' }),
      PROFILE,
      FULL,
      context,
    );
    expect(high.flags).toContain('scoi_reduced_distribution');
    expect(high.distributionMultiplier).toBe(PROFILE.constraints.scoi_reduce_multiplier);
  });

  it('SCOI very_high pauses cross-community distribution when promoted', () => {
    const paused = evaluateItemConstraints(
      makeFeatures(4, { scoi_level: 'very_high' }),
      PROFILE,
      FULL,
      context,
    );
    expect(paused.feasible).toBe(false);
    expect(paused.flags).toContain('scoi_paused');
    // Room-internal (non-cross-community) reads stay feasible.
    const internal = evaluateItemConstraints(
      makeFeatures(4, { scoi_level: 'very_high' }),
      PROFILE,
      FULL,
      { surface: 'room', crossCommunity: false },
    );
    expect(internal.feasible).toBe(true);
  });

  it('PHI above threshold triggers per-user diversification when promoted', () => {
    expect(phiDiversification(2, PROFILE, { phi: true }).diversify).toBe(true);
    expect(phiDiversification(2, PROFILE, { phi: false }).diversify).toBe(false);
    expect(phiDiversification(0.1, PROFILE, { phi: true }).diversify).toBe(false);
    expect(phiDiversification(null, PROFILE, { phi: true }).application).toBeNull();
  });

  it('GWEI disparity above threshold blocks the profile (release gate)', () => {
    const over = PROFILE.constraints.gwei_max_disparity + 0.01;
    expect(gweiDeploymentGate(over, PROFILE, { gwei: true }).blocked).toBe(true);
    expect(gweiDeploymentGate(over, PROFILE, { gwei: false }).blocked).toBe(false);
    expect(gweiDeploymentGate(over, PROFILE, { gwei: false }).application?.enforced).toBe(false);
    expect(gweiDeploymentGate(0.01, PROFILE, { gwei: true }).blocked).toBe(false);
    expect(gweiDeploymentGate(null, PROFILE, { gwei: true }).blocked).toBe(false);
  });
});
