// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Behavioral-authenticity mathematics (WS-E/WS-H bot-prevention layer 2).
//
// The platform's core wager is that participation-weighted attention carries
// RICH CONTEXT — every §22.1 aggregate binds coarse dwell, source/context
// opens, thread traversal, and return visits into one deduplicated shape.
// That richness is exactly what makes automation visible: a script that farms
// attention must jointly reproduce the VARIETY (bucket spread), the BREADTH
// (multiple interaction dimensions), and the RHYTHM (human activity is bursty
// and circadian) of genuine reading, across every window, forever.  Each
// component below measures one of those axes from the ALREADY-BUCKETED
// aggregates — no new client collection, nothing beyond what §22.1 discloses
// (WS-C.4.1d re-identification resistance is untouched).
//
// Design contract (mirrors anti-signals.ts):
//   • Pure and total — no clock, no randomness, defined for every input.
//   • Deterministic — same windows ⇒ same score (§30.6 replay).
//   • Evidence-gated — below the per-component evidence floor the component
//     is NEUTRAL (1): a quiet lurker or a brand-new reader is NEVER damped.
//   • Bounded and never zero — a floored multiplier, like the WS-O.4.5
//     account-age trust weights, so a false positive reduces influence
//     without silencing anyone.
//   • Organic-signal-only — inputs derive exclusively from the actor's own
//     behavior; two behaviorally-identical accounts score identically
//     (the WS-I.3 neutrality obligation).
import type { DwellBucket, ReplyDepthBucket, ReturnVisitBucket } from '@licio/shared';
import { z } from 'zod';

/** One actor's deduplicated behavior in one 1-hour aggregation window,
 *  folded across every item they touched (per-item MAX buckets — the same
 *  dedup the PWAtt fold applies, so repeats never inflate histograms). */
export interface ActorBehaviorWindow {
  /** ISO start of the 1h window. */
  windowStart: string;
  /** Scoring-topic events attributed to the actor in the window. */
  eventCount: number;
  /** Distinct items the actor touched. */
  itemsTouched: number;
  /** Count of items by the actor's per-item MAX dwell bucket. */
  dwellHistogram: Partial<Record<DwellBucket, number>>;
  /** Count of items by per-item MAX reply-depth traversal bucket. */
  replyDepthHistogram: Partial<Record<ReplyDepthBucket, number>>;
  /** Count of items by per-item MAX return-visit bucket. */
  returnHistogram: Partial<Record<ReturnVisitBucket, number>>;
  /** Items with a meaningful (non-bounce) source open. */
  sourceOpens: number;
  /** Items with a context-card open. */
  contextOpens: number;
  /** Items saved for later. */
  saves: number;
  /** Contributions authored in the window. */
  contributions: number;
}

export interface BehaviorAuthenticityConfig {
  /** Non-`none` dwell observations required before variety is judged. */
  minDwellEvidence: number;
  /** Normalized dwell-entropy at or above which variety is fully human. */
  entropyFloor: number;
  /** Total events required before interaction breadth is judged. */
  minBreadthEvidence: number;
  /** Active 1h windows required before rhythm is judged (≥ 3 days of use). */
  minTemporalWindows: number;
  /** Active-share of elapsed windows above which activity is machine-flat
   *  (humans sleep; ≥ this share of EVERY hour active is always-on). */
  flatnessCeiling: number;
  /** Coefficient of variation of per-window volume below which activity is
   *  metronomic (machine-constant output). */
  cvFloor: number;
  /** Per-component and composite lower bound — NEVER zero. */
  componentFloor: number;
  /** Estimated-Jaccard similarity at or above which two behavior streams are
   *  duplicates (same script, different accounts). */
  duplicationJaccard: number;
  /** Minimum near-duplicate cluster size before collective damping applies
   *  (2 accounts can be a couple on one couch; 3+ sharing an identical
   *  stream shape is a fleet). */
  minClusterSize: number;
  /** Lower bound of the per-member duplication factor (1/clusterSize floors
   *  here, so a 100-account fleet still counts as ≥ this fraction each). */
  duplicationFloor: number;
  /** Absolute lower bound of the effective authenticity multiplier. */
  overallFloor: number;
}

export const DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG: BehaviorAuthenticityConfig = {
  minDwellEvidence: 40,
  entropyFloor: 0.45,
  minBreadthEvidence: 60,
  minTemporalWindows: 48,
  flatnessCeiling: 0.85,
  cvFloor: 0.12,
  componentFloor: 0.25,
  duplicationJaccard: 0.9,
  minClusterSize: 3,
  duplicationFloor: 0.1,
  overallFloor: 0.05,
};

/** Runtime-config validation (the pwatt_config loader pattern): tunable at
 *  runtime, but never into a nonsensical shape. */
export const behaviorAuthenticityConfigSchema = z
  .object({
    minDwellEvidence: z.number().int().min(1),
    entropyFloor: z.number().min(0).max(1),
    minBreadthEvidence: z.number().int().min(1),
    minTemporalWindows: z.number().int().min(1),
    flatnessCeiling: z.number().min(0).max(1),
    cvFloor: z.number().min(0).max(2),
    componentFloor: z.number().min(0.01).max(1),
    duplicationJaccard: z.number().min(0.5).max(1),
    minClusterSize: z.number().int().min(2),
    duplicationFloor: z.number().min(0.01).max(1),
    overallFloor: z.number().min(0.01).max(1),
  })
  .strict();

/** The non-`none` dwell buckets, in order (variety is judged over these). */
const ACTIVE_DWELL_BUCKETS: readonly DwellBucket[] = [
  'glance',
  'short',
  'medium',
  'long',
  'extended',
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Normalized Shannon entropy of a positive-count distribution: 0 for a
 *  single-bucket (degenerate) distribution, 1 for uniform over the support
 *  cardinality.  Pure and total; empty input → 0. */
export function normalizedEntropy(counts: readonly number[], supportSize: number): number {
  const positive = counts.filter((c) => Number.isFinite(c) && c > 0);
  const total = positive.reduce((sum, c) => sum + c, 0);
  if (total <= 0 || supportSize <= 1) return 0;
  let entropy = 0;
  for (const count of positive) {
    const p = count / total;
    entropy -= p * Math.log(p);
  }
  return clamp01(entropy / Math.log(supportSize));
}

export interface ComponentScore {
  /** Multiplier in [componentFloor, 1]; 1 = neutral/insufficient evidence. */
  score: number;
  /** Observations the judgement rests on (0 ⇒ neutral). */
  evidence: number;
  /** True when the evidence floor was met and the pattern fired. */
  flagged: boolean;
}

const neutral = (evidence: number): ComponentScore => ({ score: 1, evidence, flagged: false });

/**
 * Dwell-bucket VARIETY.  Humans reading a feed produce a spread of per-item
 * dwell buckets (glances, skims, deep reads); an automation loop concentrates
 * in one or two.  Judged over the pooled non-`none` dwell histogram; below the
 * evidence floor → neutral.  Monotone: more entropy never lowers the score.
 */
export function dwellVarietyScore(
  windows: readonly ActorBehaviorWindow[],
  config: BehaviorAuthenticityConfig = DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG,
): ComponentScore {
  const pooled = ACTIVE_DWELL_BUCKETS.map((bucket) =>
    windows.reduce((sum, w) => sum + toCount(w.dwellHistogram[bucket]), 0),
  );
  const evidence = pooled.reduce((sum, c) => sum + c, 0);
  if (evidence < config.minDwellEvidence) return neutral(evidence);
  const entropy = normalizedEntropy(pooled, ACTIVE_DWELL_BUCKETS.length);
  if (entropy >= config.entropyFloor) return { score: 1, evidence, flagged: false };
  // Linear ramp from the floor: entropy 0 (all one bucket) → componentFloor.
  const ratio = entropy / config.entropyFloor;
  const score = Math.max(
    config.componentFloor,
    config.componentFloor + (1 - config.componentFloor) * ratio,
  );
  return { score, evidence, flagged: true };
}

/**
 * Interaction BREADTH.  The §22.1 shape carries seven context dimensions; a
 * genuine reader exercises several over time (opens a source sometimes, digs
 * into a thread sometimes, returns to something).  A high-volume stream that
 * only ever emits ONE dimension (pure dwell farming, pure return pumping) is
 * context-free automation.  Below the evidence floor → neutral.
 */
export function interactionBreadthScore(
  windows: readonly ActorBehaviorWindow[],
  config: BehaviorAuthenticityConfig = DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG,
): ComponentScore {
  const evidence = windows.reduce((sum, w) => sum + toCount(w.eventCount), 0);
  if (evidence < config.minBreadthEvidence) return neutral(evidence);
  const distinctDwell = ACTIVE_DWELL_BUCKETS.filter((bucket) =>
    windows.some((w) => toCount(w.dwellHistogram[bucket]) > 0),
  ).length;
  const dimensions = [
    distinctDwell >= 2,
    windows.some((w) => toCount(w.sourceOpens) > 0),
    windows.some((w) => toCount(w.contextOpens) > 0),
    windows.some(
      (w) =>
        toCount(w.replyDepthHistogram.shallow) +
          toCount(w.replyDepthHistogram.moderate) +
          toCount(w.replyDepthHistogram.deep) >
        0,
    ),
    windows.some(
      (w) =>
        toCount(w.returnHistogram.few) +
          toCount(w.returnHistogram.several) +
          toCount(w.returnHistogram.many) >
        0,
    ),
    windows.some((w) => toCount(w.contributions) > 0),
    windows.some((w) => toCount(w.saves) > 0),
  ].filter(Boolean).length;
  if (dimensions >= 3) return { score: 1, evidence, flagged: false };
  const score = Math.max(config.componentFloor, dimensions >= 2 ? 0.7 : 0.4);
  return { score, evidence, flagged: true };
}

/**
 * Temporal RHYTHM.  Two machine tells, judged over the actor's active-window
 * sequence once it spans the evidence floor:
 *   • FLATNESS — active in ≥ flatnessCeiling of every elapsed hour: humans
 *     sleep, machines do not.
 *   • METRONOME — per-window volume with a coefficient of variation below
 *     cvFloor: human attention is bursty; constant output is scripted.
 * Either tell fires the component; the score is the worse of the two.
 */
export function temporalRhythmScore(
  windows: readonly ActorBehaviorWindow[],
  config: BehaviorAuthenticityConfig = DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG,
): ComponentScore {
  const active = windows.filter((w) => toCount(w.eventCount) > 0);
  const evidence = active.length;
  if (evidence < config.minTemporalWindows) return neutral(evidence);
  const starts = active
    .map((w) => Date.parse(w.windowStart))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  const first = starts[0];
  const last = starts[starts.length - 1];
  if (first === undefined || last === undefined) return neutral(evidence);
  const elapsedWindows = Math.max(1, Math.round((last - first) / 3_600_000) + 1);
  const flatness = clamp01(active.length / elapsedWindows);

  const volumes = active.map((w) => toCount(w.eventCount));
  const mean = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
  const variance = volumes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / volumes.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

  let score = 1;
  if (flatness >= config.flatnessCeiling) {
    // Ramp: at the ceiling → mild damp; at fully-flat (1.0) → componentFloor.
    const over = (flatness - config.flatnessCeiling) / Math.max(1e-9, 1 - config.flatnessCeiling);
    score = Math.min(
      score,
      Math.max(config.componentFloor, 1 - (1 - config.componentFloor) * over),
    );
  }
  if (cv < config.cvFloor && mean >= 3) {
    // Metronomic volume: ramp toward the floor as CV → 0.
    const under = 1 - cv / config.cvFloor;
    score = Math.min(
      score,
      Math.max(config.componentFloor, 1 - (1 - config.componentFloor) * under),
    );
  }
  return score < 1 ? { score, evidence, flagged: true } : { score: 1, evidence, flagged: false };
}

/** Bucket labels compressed for the stream text (stable, versioned). */
const DWELL_CODE: Record<DwellBucket, string> = {
  none: '0',
  glance: 'g',
  short: 's',
  medium: 'm',
  long: 'l',
  extended: 'x',
};

/** Version tag for the behavior-stream serialization (bump on shape change —
 *  signatures from different versions must never be compared). */
export const BEHAVIOR_STREAM_VERSION = 'bhv1';

/**
 * Serialize an actor's window sequence into the canonical text stream whose
 * MinHash signature (text/minhash.ts) detects cross-account duplication: two
 * accounts driven by the same script emit near-identical streams, and the
 * estimated Jaccard over char-shingles exposes that regardless of which
 * items they touched.  Deterministic: windows are ordered by start.
 */
export function behaviorStreamText(windows: readonly ActorBehaviorWindow[]): string {
  const ordered = [...windows].sort((a, b) => a.windowStart.localeCompare(b.windowStart));
  const tokens = ordered.map((w) => {
    const dwell = ACTIVE_DWELL_BUCKETS.filter((b) => toCount(w.dwellHistogram[b]) > 0)
      .map((b) => DWELL_CODE[b])
      .join('');
    const depth =
      toCount(w.replyDepthHistogram.shallow) +
      toCount(w.replyDepthHistogram.moderate) +
      toCount(w.replyDepthHistogram.deep);
    const returns =
      toCount(w.returnHistogram.few) +
      toCount(w.returnHistogram.several) +
      toCount(w.returnHistogram.many);
    return [
      `c${toCount(w.eventCount)}`,
      `i${toCount(w.itemsTouched)}`,
      `d${dwell || '0'}`,
      `o${toCount(w.sourceOpens)}`,
      `x${toCount(w.contextOpens)}`,
      `t${depth}`,
      `r${returns}`,
      `k${toCount(w.contributions)}`,
      `v${toCount(w.saves)}`,
    ].join('');
  });
  return `${BEHAVIOR_STREAM_VERSION} ${tokens.join(' ')}`;
}

export interface AuthenticityAssessment {
  /** Composite coherence multiplier in [componentFloor, 1] (duplication NOT
   *  included — the cluster factor composes at the consumer). */
  coherence: number;
  components: {
    dwellVariety: ComponentScore;
    interactionBreadth: ComponentScore;
    temporalRhythm: ComponentScore;
  };
  /** Machine-readable names of the components that fired. */
  flags: string[];
  /** Total scoring-topic events the assessment rests on. */
  evidence: number;
}

/**
 * Compose the per-account coherence assessment.  The composite is the MINIMUM
 * of the component multipliers (a stream only as human as its worst axis),
 * floored at componentFloor.  With no fired component the composite is
 * exactly 1 — the neutral default every account starts from.
 */
export function assessAuthenticity(
  windows: readonly ActorBehaviorWindow[],
  config: BehaviorAuthenticityConfig = DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG,
): AuthenticityAssessment {
  const dwellVariety = dwellVarietyScore(windows, config);
  const interactionBreadth = interactionBreadthScore(windows, config);
  const temporalRhythm = temporalRhythmScore(windows, config);
  const flags: string[] = [];
  if (dwellVariety.flagged) flags.push('dwell_variety');
  if (interactionBreadth.flagged) flags.push('interaction_breadth');
  if (temporalRhythm.flagged) flags.push('temporal_rhythm');
  const coherence = Math.max(
    config.componentFloor,
    Math.min(dwellVariety.score, interactionBreadth.score, temporalRhythm.score),
  );
  return {
    coherence,
    components: { dwellVariety, interactionBreadth, temporalRhythm },
    flags,
    evidence: windows.reduce((sum, w) => sum + toCount(w.eventCount), 0),
  };
}

/**
 * Per-member duplication factor for a near-duplicate behavior cluster: the
 * invariant is that k accounts emitting ONE stream shape earn ~one account's
 * influence (each member ×1/k, floored).  Below the cluster-size threshold
 * the factor is 1 (no effect).
 */
export function duplicationFactor(
  clusterSize: number,
  config: BehaviorAuthenticityConfig = DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG,
): number {
  if (!Number.isFinite(clusterSize) || clusterSize < config.minClusterSize) return 1;
  return Math.max(config.duplicationFloor, 1 / clusterSize);
}

/**
 * The effective authenticity multiplier a scoring consumer applies to the
 * actor: coherence × duplication, floored at overallFloor (never zero — the
 * WS-O.4.5 doctrine: influence is reduced, never silenced).
 */
export function effectiveAuthenticity(
  coherence: number,
  clusterSize: number,
  config: BehaviorAuthenticityConfig = DEFAULT_BEHAVIOR_AUTHENTICITY_CONFIG,
): number {
  const base = clamp01(coherence) * duplicationFactor(clusterSize, config);
  return Math.max(config.overallFloor, Math.min(1, base));
}
