// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bias/subgroup audit math (WS-K.1.2a, SPEC §24.2). For each subgroup dimension
// and each measured metric, compute the best/worst performance gap and its
// statistical significance via a two-proportion z-test, then gate deployment: a
// disparity that is above threshold AND statistically significant AND not
// explicitly accepted blocks the model (enforced through the registry gate).
// Small subgroups (below the minimum sample size) are excluded from the gap —
// GWEI-style small-cohort protection — so a handful of examples cannot
// manufacture or hide a disparity.
import type {
  BiasAuditResult,
  BiasSubgroupDimension,
  Disparity,
  SubgroupMetric,
} from './schemas/evaluation.js';

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation
 *  (absolute error < 1.5e-7). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Two-proportion z-test two-tailed p-value for proportions p1 (n1) vs p2 (n2).
 * Returns 1 (no evidence of difference) when either sample is empty or the
 * pooled standard error is zero with equal proportions.
 */
export function twoProportionPValue(p1: number, n1: number, p2: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 1;
  if (p1 === p2) return 1;
  const pooled = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  // Degenerate pooled variance (pooled ∈ {0,1}) with a real gap ⇒ as-significant
  // as the data allows; report p = 0.
  if (se === 0) return 0;
  const z = (p1 - p2) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/** A metric column that can carry a disparity. */
const METRICS = ['accuracy', 'precision', 'recall', 'quality_score'] as const;
type MetricKey = (typeof METRICS)[number];

export interface BiasAuditOptions {
  /** Disparity threshold above which a significant gap blocks deployment. */
  threshold: number;
  /** Subgroups below this sample size are excluded (small-cohort protection). */
  minSampleSize?: number;
  /** Significance level for the z-test (default 0.05). */
  alpha?: number;
  /** (dimension|metric) pairs documented-accepted despite a blocking gap. */
  acceptedDisparities?: ReadonlySet<string>;
  /** Justification text required when any disparity is accepted. */
  justification?: string | null;
  datasetVersions?: BiasAuditResult['dataset_versions'];
}

/** Key for the accepted-disparities set. */
export function disparityKey(dimension: BiasSubgroupDimension, metric: MetricKey): string {
  return `${dimension}|${metric}`;
}

/**
 * Compute the bias audit from per-subgroup metrics. Deterministic and total.
 */
export function computeBiasAudit(
  metrics: readonly SubgroupMetric[],
  options: BiasAuditOptions,
): BiasAuditResult {
  const minSample = options.minSampleSize ?? 30;
  const alpha = options.alpha ?? 0.05;
  const accepted = options.acceptedDisparities ?? new Set<string>();
  const disparities: Disparity[] = [];

  // Group eligible (large-enough) metrics by dimension.
  const byDimension = new Map<BiasSubgroupDimension, SubgroupMetric[]>();
  for (const metric of metrics) {
    if (metric.sample_size < minSample) continue; // small-cohort protection
    const list = byDimension.get(metric.dimension) ?? [];
    list.push(metric);
    byDimension.set(metric.dimension, list);
  }

  for (const [dimension, group] of byDimension) {
    for (const metricKey of METRICS) {
      const present = group.filter((m) => m[metricKey] !== undefined);
      if (present.length < 2) continue; // need ≥2 subgroups to compare
      let best = present[0] as SubgroupMetric;
      let worst = present[0] as SubgroupMetric;
      for (const m of present) {
        if ((m[metricKey] as number) > (best[metricKey] as number)) best = m;
        if ((m[metricKey] as number) < (worst[metricKey] as number)) worst = m;
      }
      const bestValue = best[metricKey] as number;
      const worstValue = worst[metricKey] as number;
      const disparity = bestValue - worstValue;
      const pValue = twoProportionPValue(
        bestValue,
        best.sample_size,
        worstValue,
        worst.sample_size,
      );
      const significant = pValue < alpha;
      disparities.push({
        dimension,
        metric: metricKey,
        best_subgroup: best.subgroup,
        worst_subgroup: worst.subgroup,
        best_value: bestValue,
        worst_value: worstValue,
        disparity,
        p_value: pValue,
        significant,
        accepted: accepted.has(disparityKey(dimension, metricKey)),
      });
    }
  }

  // A disparity blocks iff it is above threshold AND significant AND not
  // accepted with documentation.
  const blocking = disparities.filter(
    (d) => d.disparity > options.threshold && d.significant && !d.accepted,
  );
  const acceptedBlocking = disparities.filter(
    (d) => d.disparity > options.threshold && d.significant && d.accepted,
  );
  const passed = blocking.length === 0;

  return {
    eval_kind: 'bias_audit',
    subgroup_metrics: [...metrics],
    disparities,
    threshold: options.threshold,
    passed,
    accepted_with_documentation: acceptedBlocking.length > 0,
    justification: acceptedBlocking.length > 0 ? (options.justification ?? null) : null,
    dataset_versions: options.datasetVersions ?? [],
  };
}
