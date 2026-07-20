// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Path-Signature Wellbeing Invariant (WS-H.7.6, SPEC §12.6).
//
// Session events become a piecewise-linear path in R^d (dimensions: topic
// progression, action type, time, engagement level — event types and
// timing ONLY, never content). The truncated path signature (iterated
// integrals to depth m, default 3) encodes ORDER-dependent behavior:
//
//   • a linear segment with increment Δ has signature exp_⊗(Δ):
//     level k = Δ^{⊗k} / k!
//   • concatenation is Chen's identity: S(X * Y) = S(X) ⊗ S(Y)
//     (level-wise truncated tensor product)
//
// Both are EXACT for piecewise-linear paths — no quadrature. Consequences
// used as tests: inserting a collinear midpoint never changes the
// signature (exp(a)⊗exp(b) = exp(a+b) for parallel a, b), while the same
// event multiset in a different ORDER changes level ≥ 2. The Lévy area
// S²[i][j] − S²[j][i] is the SIGNED circulation of the (i, j) projection —
// for (action-depth, time) it is positive when action-depth arcs ABOVE its
// start→end chord over the session and negative when it arcs BELOW: e.g.
// read→open_source→read circulates +, open_source→read→open_source circulates
// −. NOTE this sign is a geometric pacing signal, NOT a health label — it does
// not separate the health classes (a constructive read→source→question and a
// bursty scroll→reply→scroll both circulate positively), so `actionTimeArea`
// is RECORDED as an interpretable feature (persisted on the PHI output for
// calibration), not used as a classification threshold — see
// `classifySessionHealth`.
//
// Privacy: the input type carries event-type codes, topic-cluster ordinals
// and timestamps only; classification reads signature features, never text.

export interface TruncatedSignature {
  dimension: number;
  depth: number;
  /** Level 1: Δ (length d). */
  level1: number[];
  /** Level 2: d×d, row-major (S²[i][j] = entry i*d+j). */
  level2: number[];
  /** Level 3: d×d×d, row-major (S³[i][j][k] = entry (i*d+j)*d+k). */
  level3: number[];
}

export function emptySignature(dimension: number, depth = 3): TruncatedSignature {
  if (depth !== 3) throw new Error('this implementation fixes truncation depth 3');
  return {
    dimension,
    depth,
    level1: new Array<number>(dimension).fill(0),
    level2: new Array<number>(dimension * dimension).fill(0),
    level3: new Array<number>(dimension * dimension * dimension).fill(0),
  };
}

/** exp_⊗(Δ) truncated at depth 3 (exact segment signature). */
export function segmentSignature(delta: readonly number[]): TruncatedSignature {
  const d = delta.length;
  const sig = emptySignature(d);
  for (let i = 0; i < d; i += 1) sig.level1[i] = delta[i] ?? 0;
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      sig.level2[i * d + j] = ((delta[i] ?? 0) * (delta[j] ?? 0)) / 2;
    }
  }
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      for (let k = 0; k < d; k += 1) {
        sig.level3[(i * d + j) * d + k] = ((delta[i] ?? 0) * (delta[j] ?? 0) * (delta[k] ?? 0)) / 6;
      }
    }
  }
  return sig;
}

/** Chen product S ⊗ T truncated at depth 3. */
export function chenProduct(s: TruncatedSignature, t: TruncatedSignature): TruncatedSignature {
  if (s.dimension !== t.dimension) throw new Error('signature dimensions differ');
  const d = s.dimension;
  const out = emptySignature(d);
  for (let i = 0; i < d; i += 1) out.level1[i] = (s.level1[i] ?? 0) + (t.level1[i] ?? 0);
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      out.level2[i * d + j] =
        (s.level2[i * d + j] ?? 0) +
        (t.level2[i * d + j] ?? 0) +
        (s.level1[i] ?? 0) * (t.level1[j] ?? 0);
    }
  }
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      for (let k = 0; k < d; k += 1) {
        out.level3[(i * d + j) * d + k] =
          (s.level3[(i * d + j) * d + k] ?? 0) +
          (t.level3[(i * d + j) * d + k] ?? 0) +
          (s.level2[i * d + j] ?? 0) * (t.level1[k] ?? 0) +
          (s.level1[i] ?? 0) * (t.level2[j * d + k] ?? 0);
      }
    }
  }
  return out;
}

/** Signature of a piecewise-linear path through the given points. */
export function pathSignature(points: readonly (readonly number[])[]): TruncatedSignature {
  if (points.length === 0) throw new Error('path signature requires at least one point');
  const d = points[0]?.length ?? 0;
  let sig = emptySignature(d);
  for (let p = 1; p < points.length; p += 1) {
    const prev = points[p - 1];
    const next = points[p];
    if (!prev || !next || next.length !== d) throw new Error('inconsistent path dimensions');
    const delta = next.map((v, i) => v - (prev[i] ?? 0));
    sig = chenProduct(sig, segmentSignature(delta));
  }
  return sig;
}

/** Lévy (signed) area between dimensions i and j: (S²ᵢⱼ − S²ⱼᵢ)/2. */
export function signedArea(sig: TruncatedSignature, i: number, j: number): number {
  const d = sig.dimension;
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= d || j >= d) {
    throw new Error(`signedArea indices (${i}, ${j}) out of range for dimension ${d}`);
  }
  return ((sig.level2[i * d + j] ?? 0) - (sig.level2[j * d + i] ?? 0)) / 2;
}

// ---------------------------------------------------------------------------
// Session paths and health classification (WS-H.7.6b)
// ---------------------------------------------------------------------------

/** Path dimensions (fixed order). */
export const SESSION_PATH_DIMENSIONS = ['topic', 'action', 'time', 'engagement'] as const;

export const SESSION_ACTION_KINDS = [
  'read',
  'open_source',
  'open_context',
  'question',
  'reply',
  'scroll',
  'return',
] as const;
export type SessionActionKind = (typeof SESSION_ACTION_KINDS)[number];

export interface SessionPathEvent {
  /** Action kind — a closed enum, never content. */
  kind: SessionActionKind;
  /** Coarse topic-cluster ordinal (stable within the session). */
  topicOrdinal: number;
  atMs: number;
  /** Engagement level in [0, 1] (active-dwell bucket midpoint). */
  engagement: number;
}

/** Action-depth coordinate: deliberate, source-seeking actions climb. */
const ACTION_DEPTH: Record<SessionActionKind, number> = {
  scroll: 0,
  read: 1,
  return: 0.5,
  reply: 1.5,
  open_context: 2,
  question: 2.5,
  open_source: 3,
};

/**
 * Map session events to path points in R⁴ (topic, action-depth, time,
 * engagement). Time is normalized to the session span so signatures are
 * comparable across sessions (signatures are reparameterization-invariant,
 * but the time AXIS still carries pacing via the other dimensions' areas).
 */
export function sessionPathPoints(events: readonly SessionPathEvent[]): number[][] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.atMs - b.atMs);
  const start = sorted[0]?.atMs ?? 0;
  const span = Math.max(1, (sorted[sorted.length - 1]?.atMs ?? 0) - start);
  return sorted.map((event) => [
    event.topicOrdinal,
    ACTION_DEPTH[event.kind],
    (event.atMs - start) / span,
    Math.min(1, Math.max(0, event.engagement)),
  ]);
}

export const SESSION_HEALTH_CLASSES = [
  'constructive',
  'casual',
  'narrowing',
  'compulsive',
  'rage',
] as const;
export type SessionHealthClass = (typeof SESSION_HEALTH_CLASSES)[number];

export interface SessionHealthResult {
  classification: SessionHealthClass;
  /** Interpretable features behind the call (logged for improvement). */
  features: {
    eventCount: number;
    distinctTopics: number;
    topicRevisitRatio: number;
    deepActionShare: number;
    rapidReturnCount: number;
    actionTimeArea: number;
  };
}

export interface SessionHealthConfig {
  /** Same-topic revisit ratio above which a session is narrowing. */
  narrowingRevisitRatio: number;
  /** Rapid returns (≤ rapidReturnMs apart) to call a session compulsive. */
  compulsiveReturnThreshold: number;
  rapidReturnMs: number;
  /** Deep-action share (source/context/question) for constructive. */
  constructiveDeepShare: number;
  /** Reply share arriving faster than rapidReturnMs that signals rage. */
  rageRapidReplyShare: number;
}

export const DEFAULT_SESSION_HEALTH_CONFIG: SessionHealthConfig = {
  narrowingRevisitRatio: 0.6,
  compulsiveReturnThreshold: 3,
  rapidReturnMs: 60_000,
  constructiveDeepShare: 0.3,
  rageRapidReplyShare: 0.25,
};

/**
 * Classify session health from the path and its signature features
 * (WS-H.7.6b). The classification runs on the interpretable scalar heuristics
 * (rapid-reply/return, revisit ratio, deep-action share). The signature's
 * action×time signed area (`actionTimeArea`) is ALSO returned in `features` and
 * PERSISTED on the PHI invariant output (see `services-impl.ts`) as an
 * order-sensitive calibration signal — it is deliberately NOT a classification
 * threshold: the area's SIGN is a geometric pacing signal that does not separate
 * the health classes (verified — a constructive read→source→question and a
 * bursty scroll→reply→scroll both circulate positively). A learned model over
 * the full signature, not a hand-picked threshold on this one projection, is the
 * principled way to consume it; that is tracked as a residual
 * (docs/invariants/README.md).
 */
export function classifySessionHealth(
  events: readonly SessionPathEvent[],
  config: SessionHealthConfig = DEFAULT_SESSION_HEALTH_CONFIG,
): SessionHealthResult {
  const sorted = [...events].sort((a, b) => a.atMs - b.atMs);
  const points = sessionPathPoints(sorted);
  const sig = points.length >= 2 ? pathSignature(points) : emptySignature(4);
  const actionTimeArea = signedArea(sig, 1, 2);

  const topics = sorted.map((e) => e.topicOrdinal);
  const distinctTopics = new Set(topics).size;
  let revisits = 0;
  const seen = new Set<number>();
  let previousTopic: number | null = null;
  for (const topic of topics) {
    if (previousTopic !== null && topic !== previousTopic && seen.has(topic)) revisits += 1;
    seen.add(topic);
    previousTopic = topic;
  }
  const transitions = Math.max(1, sorted.length - 1);
  const topicRevisitRatio = revisits / transitions;

  const deepActions = sorted.filter(
    (e) => e.kind === 'open_source' || e.kind === 'open_context' || e.kind === 'question',
  ).length;
  const deepActionShare = sorted.length === 0 ? 0 : deepActions / sorted.length;

  let rapidReturnCount = 0;
  let rapidReplies = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const previous = sorted[i - 1];
    if (!current || !previous) continue;
    const gap = current.atMs - previous.atMs;
    if (current.kind === 'return' && gap <= config.rapidReturnMs) rapidReturnCount += 1;
    if (current.kind === 'reply' && gap <= config.rapidReturnMs) rapidReplies += 1;
  }
  const rapidReplyShare = sorted.length === 0 ? 0 : rapidReplies / sorted.length;

  const features = {
    eventCount: sorted.length,
    distinctTopics,
    topicRevisitRatio,
    deepActionShare,
    rapidReturnCount,
    actionTimeArea,
  };

  // Priority: harm signals first, then constructive, then default casual.
  let classification: SessionHealthClass = 'casual';
  if (rapidReplyShare >= config.rageRapidReplyShare && rapidReplies >= 2) {
    classification = 'rage';
  } else if (rapidReturnCount >= config.compulsiveReturnThreshold) {
    classification = 'compulsive';
  } else if (topicRevisitRatio >= config.narrowingRevisitRatio && distinctTopics <= 3) {
    classification = 'narrowing';
  } else if (deepActionShare >= config.constructiveDeepShare) {
    classification = 'constructive';
  }
  return { classification, features };
}

export const PATHSIG_VERSION = '1.0.0';
