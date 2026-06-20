// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI accuracy metrics (WS-K.1.3c, SPEC §24.2). Computes correction rate,
// agreement rate, and per-category accuracy from accumulated steward
// corrections — using stewards as ground truth — so model quality is tracked
// over time and feeds the runtime monitor (WS-K.1.2f). Pure and total.

import type { AiUseCaseId } from './schemas/common.js';
import type { AiAccuracyMetrics, AiCorrection } from './schemas/correction.js';

/** Compute accuracy metrics for one use case from its corrections. */
export function computeAccuracyMetrics(
  useCaseId: AiUseCaseId,
  corrections: readonly AiCorrection[],
  nowIso: string,
): AiAccuracyMetrics {
  const relevant = corrections.filter((c) => c.use_case_id === useCaseId);
  const total = relevant.length;
  const confirmed = relevant.filter((c) => c.action === 'confirm').length;
  const rejected = relevant.filter((c) => c.action === 'reject').length;
  const modified = relevant.filter((c) => c.action === 'modify').length;

  // Per-category roll-up (corrections carrying a category).
  const byCategory = new Map<string, { total: number; confirmed: number }>();
  for (const c of relevant) {
    if (c.category === null) continue;
    const bucket = byCategory.get(c.category) ?? { total: 0, confirmed: 0 };
    bucket.total += 1;
    if (c.action === 'confirm') bucket.confirmed += 1;
    byCategory.set(c.category, bucket);
  }
  const perCategory = [...byCategory.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, stats]) => ({
      category,
      total: stats.total,
      agreement_rate: stats.total === 0 ? 0 : stats.confirmed / stats.total,
    }));

  return {
    use_case_id: useCaseId,
    total,
    confirmed,
    rejected,
    modified,
    correction_rate: total === 0 ? 0 : (rejected + modified) / total,
    agreement_rate: total === 0 ? 0 : confirmed / total,
    per_category: perCategory,
    computed_at: nowIso,
  };
}
