// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.6b/c — per-item explanation generation. Selects the highest-priority
// applicable template from the item's ACTUAL ranking signal profile (the same
// score components recorded in the decision log — explanations cannot drift
// from decisions) and renders it with concrete parameters. Constraint/safety
// "slowing" explanations outrank positive ones (a slowed item must say so to
// every viewer, WS-I.2.6c). Every item gets SOME explanation: the generic
// freshness template is the floor, never an empty string and never vague
// prohibited phrasing.

import type { FeatureVector } from '../schemas/feature-vector.js';
import type { ConstraintFlag, ScoredItem } from '../schemas/scored-item.js';
import {
  type ExplanationLocale,
  type ExplanationTemplate,
  renderTemplate,
  TPL_BRIDGE_ACTIVE,
  TPL_CASCADE_SLOWED,
  TPL_CHRONOLOGICAL,
  TPL_FRESH_DIVERSITY,
  TPL_INDEPENDENT_SOURCE,
  TPL_INTERPRETATIONS_DIFFER,
  TPL_MFCI_SLOWED,
  TPL_PHI_BROADER,
  TPL_RANKING_PAUSED,
  TPL_RECENT_SUBMISSION,
  TPL_REPEATED_CLAIM,
  TPL_SOURCE_OPENS,
  TPL_SOURCES_RISING,
  TPL_UNDER_REVIEW,
} from './templates.js';

export interface ExplanationSignals {
  /** Distinct rooms with recent activity on the item (for room counts). */
  roomCount: number;
  /** SOURCED contributions on the item's thread (comments carrying ≥1 citation). */
  sourcedCount: number;
  /** True when this item was admitted under a diversity quota. */
  fromDiversityQuota: boolean;
  /** True when the requesting user has previously seen this story. */
  previouslySeen: boolean;
}

export interface GeneratedExplanation {
  templateId: string;
  distributionReason: string;
}

interface Candidate {
  template: ExplanationTemplate<never>;
  params: unknown;
}

/**
 * Choose and render the most relevant explanation for one ranked item.
 * Deterministic: same inputs ⇒ same template ⇒ same string.
 */
export function explainItem(
  scored: ScoredItem,
  features: Pick<FeatureVector, 'scoi_level' | 'mfci_risk_state'>,
  signals: ExplanationSignals,
  locale: ExplanationLocale = 'en',
): GeneratedExplanation {
  const flags = new Set<ConstraintFlag>(scored.constraint_flags);
  const candidates: Candidate[] = [];

  // Constraint/safety signals (WS-I.2.6c — shown to ALL viewers; factual,
  // non-accusatory, no thresholds or raw statistics in any params).
  if (features.mfci_risk_state === 'severe') {
    candidates.push({ template: TPL_UNDER_REVIEW as never, params: {} });
  } else if (features.mfci_risk_state === 'high' || features.mfci_risk_state === 'elevated') {
    candidates.push({ template: TPL_MFCI_SLOWED as never, params: {} });
  }
  if (flags.has('mfci_review_flagged') && features.mfci_risk_state === undefined) {
    candidates.push({ template: TPL_CASCADE_SLOWED as never, params: {} });
  }
  if (flags.has('scoi_context_card') || flags.has('scoi_reduced_distribution')) {
    candidates.push({ template: TPL_INTERPRETATIONS_DIFFER as never, params: {} });
  }
  if (flags.has('phi_diversify')) {
    candidates.push({ template: TPL_PHI_BROADER as never, params: {} });
  }

  // Penalty-driven constraint explanations.
  if (
    scored.penalty_components.redundancy.enforced &&
    scored.penalty_components.redundancy.value > 0.5
  ) {
    candidates.push({ template: TPL_REPEATED_CLAIM as never, params: {} });
  }

  // Positive signals from the actual score components.
  const components = scored.score_components;
  if (
    (components.constructive_participation ?? 0) > 0.3 &&
    signals.sourcedCount > 0 &&
    signals.roomCount > 0
  ) {
    candidates.push({
      template: TPL_SOURCES_RISING as never,
      params: { roomCount: signals.roomCount, sourcedCount: signals.sourcedCount },
    });
  }
  if ((components.exposure_independence ?? 0) > 0.6 && signals.previouslySeen) {
    candidates.push({ template: TPL_INDEPENDENT_SOURCE as never, params: {} });
  }
  if ((components.context_coherence_gain ?? 0) > 0.6) {
    candidates.push({ template: TPL_BRIDGE_ACTIVE as never, params: {} });
  }
  if ((components.active_attention ?? 0) > 0.4) {
    candidates.push({ template: TPL_SOURCE_OPENS as never, params: {} });
  }
  if (signals.fromDiversityQuota) {
    candidates.push({ template: TPL_FRESH_DIVERSITY as never, params: {} });
  }

  // Floor: every item explains itself (fresh submission is always true of
  // something that made the feed with no stronger signal).
  candidates.push({ template: TPL_RECENT_SUBMISSION as never, params: {} });

  const best = candidates.sort(
    (a, b) =>
      b.template.priority - a.template.priority ||
      a.template.templateId.localeCompare(b.template.templateId),
  )[0] as Candidate;
  return {
    templateId: best.template.templateId,
    distributionReason: renderTemplate(best.template.templateId, best.params, locale),
  };
}

/** Reasons the fallback ranker can serve (mirrors the decision log enum). */
export type FallbackReason =
  | 'kill_switch'
  | 'pipeline_error'
  | 'user_mode'
  | 'empty_pool'
  | 'gwei_gate';

/** The honest fallback explanations (WS-I.4.1b). */
export function fallbackExplanation(
  reason: FallbackReason,
  locale: ExplanationLocale = 'en',
): GeneratedExplanation {
  // A user-CHOSEN chronological mode and an empty pool say "time order";
  // every safety/incident path says "ranking is paused" honestly.
  const template =
    reason === 'user_mode' || reason === 'empty_pool' ? TPL_CHRONOLOGICAL : TPL_RANKING_PAUSED;
  return {
    templateId: template.templateId,
    distributionReason: renderTemplate(template.templateId, {}, locale),
  };
}
