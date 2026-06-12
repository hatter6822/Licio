// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SCOI-5 validation harness (WS-H.4.2c, SPEC §30.4 SCOI acceptance):
// "SCOI features are validated against human-labeled context-collapse
// cases." This module carries the CURATED labeled case set — constructed
// scenarios whose context-collapse severity was assigned by a human
// reviewer (the rationale is recorded per case) — plus the rank-correlation
// check the CI suite and the promotion evidence run. Production human
// labels accumulate post-launch through the steward report surface; this
// curated set is the pre-launch floor, and EXTENDING it is a reviewed code
// change (the cases are part of the validation contract).

import { type SheafStructure, scoiEnergy } from './sheaf.js';

/** Human-assigned severity, ordinal: 0 coherent, 1 mild, 2 collapse. */
export type ContextCollapseLabel = 0 | 1 | 2;

export interface LabeledContextCase {
  name: string;
  /** Why the human reviewer assigned the label (the audit trail). */
  rationale: string;
  label: ContextCollapseLabel;
  structure: SheafStructure;
}

const I4 = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

function lens(lensId: string, interpretation: number[]) {
  return { lensId, interpretation };
}

function overlap(lensA: string, lensB: string) {
  return { lensA, lensB, rhoA: I4, rhoB: I4 };
}

/**
 * The curated set. Interpretations are unit-ball vectors in a shared
 * 4-dimensional comparison space; geometry encodes the scenario the
 * rationale describes.
 */
export const LABELED_CONTEXT_CASES: readonly LabeledContextCase[] = [
  {
    name: 'municipal-notice-consensus',
    rationale:
      'Three communities read a routine water-maintenance notice the same way; no context is missing.',
    label: 0,
    structure: {
      lenses: [
        lens('residents', [1, 0, 0, 0]),
        lens('engineers', [1, 0, 0, 0]),
        lens('press', [1, 0, 0, 0]),
      ],
      overlaps: [
        overlap('residents', 'engineers'),
        overlap('engineers', 'press'),
        overlap('residents', 'press'),
      ],
    },
  },
  {
    name: 'minor-emphasis-difference',
    rationale:
      'Two communities agree on the facts of a zoning change but weight the traffic impact differently — a nuance, not a collapse.',
    label: 0,
    structure: {
      lenses: [lens('residents', [0.98, 0.19, 0, 0]), lens('planners', [1, 0, 0, 0])],
      overlaps: [overlap('residents', 'planners')],
    },
  },
  {
    name: 'technical-vs-lived-reading',
    rationale:
      'Engineers read a sampling anomaly as procedural; residents read it as a health concern. Substantial divergence that added context can bridge — mild collapse.',
    label: 1,
    structure: {
      lenses: [lens('engineers', [1, 0, 0, 0]), lens('residents', [0.45, 0.89, 0, 0])],
      overlaps: [overlap('engineers', 'residents')],
    },
  },
  {
    name: 'three-way-partial-drift',
    rationale:
      'Three communities each share part of a budget story but drift on causes; pairwise readings half-agree — mild collapse.',
    label: 1,
    structure: {
      lenses: [
        lens('parents', [1, 0, 0, 0]),
        lens('teachers', [0.7, 0.7, 0, 0]),
        lens('board', [0.7, 0, 0.7, 0]),
      ],
      overlaps: [overlap('parents', 'teachers'), overlap('teachers', 'board')],
    },
  },
  {
    name: 'opposed-readings-of-protest',
    rationale:
      'Two communities read the same footage as opposite events (peaceful march vs violent riot). The readings cannot be reconciled without added context — collapse.',
    label: 2,
    structure: {
      lenses: [lens('community-a', [1, 0, 0, 0]), lens('community-b', [-1, 0, 0, 0])],
      overlaps: [overlap('community-a', 'community-b')],
    },
  },
  {
    name: 'weaponizable-double-meaning',
    rationale:
      'A phrase reads as satire in its home community and as a literal threat outside it; every overlap maximally disagrees — collapse.',
    label: 2,
    structure: {
      lenses: [
        lens('home', [0, 1, 0, 0]),
        lens('outside', [0, -1, 0, 0]),
        lens('press', [0.9, -0.43, 0, 0]),
      ],
      overlaps: [overlap('home', 'outside'), overlap('home', 'press'), overlap('outside', 'press')],
    },
  },
] as const;

export interface ScoiValidationReport {
  /** Spearman rank correlation between SCOI scores and human labels. */
  spearman: number;
  /** Every collapse case scores strictly above every coherent case. */
  separation: boolean;
  cases: Array<{ name: string; label: ContextCollapseLabel; scoi: number }>;
  pass: boolean;
}

function rankOf(values: readonly number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]?.value === sorted[i]?.value) j += 1;
    const rank = (i + j) / 2 + 1; // average rank for ties
    for (let k = i; k <= j; k += 1) {
      const entry = sorted[k];
      if (entry) ranks[entry.index] = rank;
    }
    i = j + 1;
  }
  return ranks;
}

/** Spearman ρ via Pearson correlation of the (tie-averaged) ranks. */
export function spearmanCorrelation(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length < 2) {
    throw new Error('spearmanCorrelation requires two equal-length series (n >= 2)');
  }
  const ra = rankOf(a);
  const rb = rankOf(b);
  const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let k = 0; k < ra.length; k += 1) {
    const da = (ra[k] ?? 0) - ma;
    const db = (rb[k] ?? 0) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/**
 * Run the SCOI-5 validation: scores must rank-correlate with the human
 * labels (ρ ≥ minSpearman) AND separate the extremes (every collapse case
 * strictly above every coherent case).
 */
export function validateScoiAgainstLabels(
  cases: readonly LabeledContextCase[] = LABELED_CONTEXT_CASES,
  minSpearman = 0.8,
): ScoiValidationReport {
  const scored = cases.map((entry) => ({
    name: entry.name,
    label: entry.label,
    scoi: scoiEnergy(entry.structure).scoi,
  }));
  const spearman = spearmanCorrelation(
    scored.map((c) => c.scoi),
    scored.map((c) => c.label),
  );
  const coherent = scored.filter((c) => c.label === 0).map((c) => c.scoi);
  const collapse = scored.filter((c) => c.label === 2).map((c) => c.scoi);
  const separation =
    coherent.length > 0 && collapse.length > 0 && Math.min(...collapse) > Math.max(...coherent);
  return { spearman, separation, cases: scored, pass: spearman >= minSpearman && separation };
}
