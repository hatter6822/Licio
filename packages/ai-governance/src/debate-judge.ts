// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The debate adjudicator (WS-T, SPEC §24.1/§24.6). A governed PROBABILISTIC
// NEURAL model inside a deterministic, auditable, verifiable shell:
//
//   • NEURAL + PROBABILISTIC — a small multi-layer perceptron (one ReLU hidden
//     layer) followed by a softmax, so the output is a calibrated probability
//     distribution over {incumbent, challenger, inconclusive}, not a hand-coded
//     if/else. The winner is the argmax; the confidence is its probability.
//   • DETERMINISTIC / AUDITABLE / VERIFIABLE — the weights are a PINNED,
//     versioned artifact (DEBATE_JUDGE_WEIGHTS); the forward pass is pure
//     TypeScript with a fixed evaluation order (same input ⇒ byte-identical
//     output, fully replayable); the weights version is folded into the model
//     config so the AIOutputRecord config hash pins the exact decision surface.
//     Real TRAINED weights swap into the same artifact behind the same
//     registry/eval/guard machinery without touching any governance code — the
//     WS-K "real model backend is a seam" contract.
//
// The inputs are CONTENT-STRUCTURAL ONLY — source count, independent-domain
// count, link-safety pass rate, source reliability (WS-F), evidence substance
// (over the side's LOCKED underlying content + its rebuttal statement), and
// direct rebuttal.  There is NO author, topic, viewpoint, wealth, or payment
// feature, so the adjudicator cannot encode viewpoint preference (neutrality)
// and is not a member vote/tally (no-applause; the verdict is an adjudication).
//
// Depends only on @licio/shared.  Browser-safe, zero I/O, zero network egress.
import type {
  DebateJudgeInput,
  DebateJudgeSideInput,
  DebateVerdict,
  DebateWinner,
} from '@licio/shared';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Feature extraction (content-structural; every value normalized to [0,1]).
// ---------------------------------------------------------------------------

/** Saturation caps: enough independent, safe, reliable sources to be decisive. */
const SOURCE_SATURATION = 5;
const SUBSTANCE_SATURATION_TOKENS = 200;

/** The six per-side features, in the fixed order the model consumes. */
export interface DebateSideFeatures {
  /** Normalized source count (min(n/5, 1)). */
  sourceCount: number;
  /** Normalized count of DISTINCT registrable domains (independence). */
  independentDomains: number;
  /** Fraction of sources that passed the WS-G link-safety verdict. */
  linkSafeRate: number;
  /** Mean known WS-F reliability × the fraction of sources with a known signal. */
  effectiveReliability: number;
  /** Normalized substance of the side's material — the locked underlying
   *  content PLUS the rebuttal statement (min(tokens/200, 1)). */
  substance: number;
  /** 1 when this side directly rebuts the opponent, else 0. */
  rebuts: number;
}

/** The feature order the weight matrix columns follow (per side). */
export const DEBATE_FEATURE_NAMES = [
  'source_count',
  'independent_domains',
  'link_safe_rate',
  'effective_reliability',
  'substance',
  'rebuts',
] as const;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** ASCII-whitespace token count without regex (deterministic, ReDoS-free). */
function tokenCount(text: string): number {
  let count = 0;
  let inWord = false;
  for (const ch of text) {
    const ws =
      ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
    if (ws) {
      inWord = false;
    } else if (!inWord) {
      count += 1;
      inWord = true;
    }
  }
  return count;
}

/** Extract the six normalized features from one side's material. */
export function extractSideFeatures(side: DebateJudgeSideInput): DebateSideFeatures {
  const sources = side.sources;
  const n = sources.length;
  const domains = new Set<string>();
  let safe = 0;
  let reliabilitySum = 0;
  let reliabilityKnown = 0;
  for (const s of sources) {
    if (s.domain !== null) domains.add(s.domain.toLowerCase());
    if (s.link_safe) safe += 1;
    if (s.reliability !== null) {
      reliabilitySum += s.reliability;
      reliabilityKnown += 1;
    }
  }
  const meanReliability = reliabilityKnown > 0 ? reliabilitySum / reliabilityKnown : 0;
  const coverage = n > 0 ? reliabilityKnown / n : 0;
  return {
    sourceCount: clamp01(n / SOURCE_SATURATION),
    independentDomains: clamp01(domains.size / SOURCE_SATURATION),
    linkSafeRate: n > 0 ? clamp01(safe / n) : 0,
    effectiveReliability: clamp01(meanReliability * coverage),
    substance: clamp01(
      (tokenCount(side.content) + tokenCount(side.summary)) / SUBSTANCE_SATURATION_TOKENS,
    ),
    rebuts: side.rebuts_opponent ? 1 : 0,
  };
}

/** The 12-dim input vector: incumbent's six features then the challenger's six. */
export function toFeatureVector(features: {
  incumbent: DebateSideFeatures;
  challenger: DebateSideFeatures;
}): number[] {
  const order = (f: DebateSideFeatures): number[] => [
    f.sourceCount,
    f.independentDomains,
    f.linkSafeRate,
    f.effectiveReliability,
    f.substance,
    f.rebuts,
  ];
  return [...order(features.incumbent), ...order(features.challenger)];
}

// ---------------------------------------------------------------------------
// The pinned neural weights artifact.
// ---------------------------------------------------------------------------

/**
 * The debate-adjudicator weights (the versioned, governed artifact).  A two-layer
 * MLP: 12 inputs → 4 ReLU hidden units → 3 output logits → softmax.
 *
 * The hidden units are constructed from a documented RUBRIC so the decision
 * surface is auditable rather than a black box (real trained weights swap in via
 * this same artifact).  With per-side "strength"
 *   z = 0.20·sources + 0.25·domains + 0.15·linkSafe + 0.20·reliability
 *       + 0.10·substance + 0.10·rebuts   (independence weighted highest)
 * the hidden units compute the incumbent/challenger lead and each side's absolute
 * strength; the output layer maps a lead to that side's class and a near-tie to
 * `inconclusive`.  The softmax turns the logits into a probability.
 */
export interface DebateJudgeWeights {
  version: string;
  featureNames: readonly string[];
  /** Class order of the output logits. */
  classes: readonly ['incumbent', 'challenger', 'inconclusive'];
  hidden: { w: readonly (readonly number[])[]; b: readonly number[] };
  output: { w: readonly (readonly number[])[]; b: readonly number[] };
}

// Rubric importance per feature (sums to 1): independence > sources ≈ reliability
// > link-safety > substance ≈ rebuttal.
const R = { src: 0.2, dom: 0.25, safe: 0.15, rel: 0.2, sub: 0.1, reb: 0.1 } as const;
const K = 4; // difference amplifier (a modest lead → a confident probability)
const A = 1; // lead → winner-class weight
const B = 0.3; // absolute-strength → winner-class weight
const D = 1.5; // lead → inconclusive suppression
const C0 = 0.6; // inconclusive bias (dominates when neither side leads)

const RUBRIC_ROW = [R.src, R.dom, R.safe, R.rel, R.sub, R.reb] as const;
const ZERO_ROW = [0, 0, 0, 0, 0, 0] as const;
const K_RUBRIC = RUBRIC_ROW.map((v) => K * v);
const K_NEG_RUBRIC = RUBRIC_ROW.map((v) => -K * v);

// 1.1.0: the substance feature now spans the side's LOCKED underlying content
// + its rebuttal statement (the 24h live-window redesign) — same rubric, same
// architecture; the version bump re-pins the decision surface in every
// AIOutputRecord config hash.
export const DEBATE_JUDGE_WEIGHTS_VERSION = '1.1.0';

export const DEBATE_JUDGE_WEIGHTS: DebateJudgeWeights = {
  version: DEBATE_JUDGE_WEIGHTS_VERSION,
  featureNames: [
    ...DEBATE_FEATURE_NAMES.map((n) => `incumbent_${n}`),
    ...DEBATE_FEATURE_NAMES.map((n) => `challenger_${n}`),
  ],
  classes: ['incumbent', 'challenger', 'inconclusive'],
  hidden: {
    w: [
      // h0 = relu(K·(z_I − z_C)) — incumbent lead
      [...K_RUBRIC, ...K_NEG_RUBRIC],
      // h1 = relu(K·(z_C − z_I)) — challenger lead
      [...K_NEG_RUBRIC, ...K_RUBRIC],
      // h2 = relu(z_I) — incumbent absolute strength
      [...RUBRIC_ROW, ...ZERO_ROW],
      // h3 = relu(z_C) — challenger absolute strength
      [...ZERO_ROW, ...RUBRIC_ROW],
    ],
    b: [0, 0, 0, 0],
  },
  output: {
    w: [
      [A, -A, B, -B], // incumbent
      [-A, A, -B, B], // challenger
      [-D, -D, 0, 0], // inconclusive
    ],
    b: [0, 0, C0],
  },
};

// ---------------------------------------------------------------------------
// Forward pass (pure; fixed evaluation order ⇒ replayable).
// ---------------------------------------------------------------------------

function relu(x: number): number {
  return x > 0 ? x : 0;
}

function dot(row: readonly number[], vec: readonly number[]): number {
  let sum = 0;
  const len = Math.min(row.length, vec.length);
  for (let i = 0; i < len; i += 1) sum += (row[i] ?? 0) * (vec[i] ?? 0);
  return sum;
}

function softmax(logits: readonly number[]): number[] {
  const max = logits.reduce((m, v) => (v > m ? v : m), Number.NEGATIVE_INFINITY);
  const exps = logits.map((v) => Math.exp(v - max));
  const total = exps.reduce((s, v) => s + v, 0) || 1;
  return exps.map((v) => v / total);
}

/** Run the MLP forward: input vector → class probabilities (softmax). */
export function forward(x: readonly number[], weights: DebateJudgeWeights): number[] {
  const hidden = weights.hidden.w.map((row, i) => relu(dot(row, x) + (weights.hidden.b[i] ?? 0)));
  const logits = weights.output.w.map((row, i) => dot(row, hidden) + (weights.output.b[i] ?? 0));
  return softmax(logits);
}

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------

export const debateJudgeVerdictSchema = z
  .object({
    model_version: z.string(),
    winner: z.enum(['incumbent', 'challenger', 'none']),
    verdict: z.enum(['upheld', 'corrected', 'inconclusive']),
    /** The winning class probability (softmax max), 0..1. */
    confidence: z.number().min(0).max(1),
    probabilities: z
      .object({
        incumbent: z.number().min(0).max(1),
        challenger: z.number().min(0).max(1),
        inconclusive: z.number().min(0).max(1),
      })
      .strict(),
    rationale: z.string(),
  })
  .strict();
export type DebateJudgeVerdict = z.infer<typeof debateJudgeVerdictSchema>;

/** Map the winning class to the shared verdict + winner vocabulary. Exported
 *  so every adjudicator backend (the MLP here, the governed LLM leg in
 *  apps/api) maps a winning class to the SAME outcome vocabulary — outcome
 *  mapping is deterministic shell logic, never model output. */
export function debateClassToOutcome(cls: 'incumbent' | 'challenger' | 'inconclusive'): {
  verdict: DebateVerdict;
  winner: DebateWinner;
} {
  if (cls === 'incumbent') return { verdict: 'upheld', winner: 'incumbent' };
  if (cls === 'challenger') return { verdict: 'corrected', winner: 'challenger' };
  return { verdict: 'inconclusive', winner: 'none' };
}

const FEATURE_LABELS: Readonly<Record<keyof DebateSideFeatures, string>> = {
  sourceCount: 'more sources',
  independentDomains: 'more independent sources',
  linkSafeRate: 'safer sources',
  effectiveReliability: 'more reliable sources',
  substance: 'a more substantial argument',
  rebuts: 'a direct rebuttal',
};

/** Build a deterministic, feature-grounded rationale (no free-form text). */
function buildRationale(
  cls: 'incumbent' | 'challenger' | 'inconclusive',
  inc: DebateSideFeatures,
  chal: DebateSideFeatures,
): string {
  if (cls === 'inconclusive') {
    return 'Both sides presented comparably sourced cases; no side clearly prevailed, so nothing is marked incorrect.';
  }
  const winnerName = cls === 'incumbent' ? 'The incumbent' : 'The challenger';
  const w = cls === 'incumbent' ? inc : chal;
  const l = cls === 'incumbent' ? chal : inc;
  const diffs: { key: keyof DebateSideFeatures; delta: number }[] = (
    Object.keys(FEATURE_LABELS) as (keyof DebateSideFeatures)[]
  )
    .map((key) => ({ key, delta: w[key] - l[key] }))
    .filter((d) => d.delta > 0.0001)
    .sort((a, b) => b.delta - a.delta);
  if (diffs.length === 0) {
    return `${winnerName} prevailed on the balance of the sourced evidence.`;
  }
  const reasons = diffs.slice(0, 3).map((d) => FEATURE_LABELS[d.key]);
  const list =
    reasons.length === 1
      ? reasons[0]
      : `${reasons.slice(0, -1).join(', ')} and ${reasons[reasons.length - 1]}`;
  return `${winnerName} prevailed with ${list}.`;
}

/**
 * Adjudicate a debate: extract content-structural features, run the neural
 * forward pass, and return the probabilistic verdict with a feature-grounded
 * rationale.  Deterministic and replayable for a fixed `weights` artifact.
 */
export function judgeDebate(
  input: DebateJudgeInput,
  weights: DebateJudgeWeights = DEBATE_JUDGE_WEIGHTS,
): DebateJudgeVerdict {
  const incumbent = extractSideFeatures(input.incumbent);
  const challenger = extractSideFeatures(input.challenger);
  const x = toFeatureVector({ incumbent, challenger });
  const probs = forward(x, weights);
  // Fixed class order [incumbent, challenger, inconclusive]; argmax by the first
  // maximal index (ties resolve to `inconclusive`-earliest — deterministic).
  const [pInc = 0, pChal = 0, pInconc = 0] = probs;
  let cls: 'incumbent' | 'challenger' | 'inconclusive' = 'inconclusive';
  let best = pInconc;
  if (pInc > best) {
    best = pInc;
    cls = 'incumbent';
  }
  if (pChal > best) {
    best = pChal;
    cls = 'challenger';
  }
  const { verdict, winner } = debateClassToOutcome(cls);
  return debateJudgeVerdictSchema.parse({
    model_version: weights.version,
    winner,
    verdict,
    confidence: best,
    probabilities: { incumbent: pInc, challenger: pChal, inconclusive: pInconc },
    rationale: buildRationale(cls, incumbent, challenger),
  });
}
