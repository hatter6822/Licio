// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MERI multi-dimensional independence assessment (WS-H.2.2a, SPEC §7.4).
//
// Each of the six SPEC §7.4 dimensions is a pure scored function returning
// an independence signal in [0, 1] for a candidate exposure against an
// already-selected exposure (1 = fully independent along that axis). The
// combined assessment is a weighted mean — a descriptive diagnostic feeding
// MERI confidence and the topic-page lineage drawer, never a truth score.
//
// Inputs are declarative features the WS-F/WS-G stores provide (publisher
// lineage, claim/evidence groups, room origin, embedding similarity,
// timestamps); the scorers themselves contain no I/O.

export interface IndependenceFeatures {
  /** Publisher/ownership chain identifiers, outermost owner first. */
  publisherLineage: readonly string[];
  /** Byline/author identifier, when known. */
  authorId?: string | null | undefined;
  /** Wire/syndication origin id, when the item came over a wire. */
  wireOriginId?: string | null | undefined;
  /** Primary-document identifier when the item IS or carries one. */
  primaryDocumentId?: string | null | undefined;
  /** Claim-content groups present in the item. */
  claimGroupIds: readonly string[];
  /** Evidence-basis groups (independent data/witness/document/study). */
  evidenceGroupIds: readonly string[];
  /** Originating community (room id), when submitted through a room. */
  communityId?: string | null | undefined;
  /** Cosine similarity of framing embeddings vs the other item, in [0, 1]. */
  framingSimilarity?: number | undefined;
  /** True when classifiers mark this item's framing misleading. */
  misleading?: boolean | undefined;
  /** Publication/submission instant (ms epoch). */
  publishedAtMs: number;
  /** True when the item adds facts beyond the compared item. */
  addsNewFacts?: boolean | undefined;
}

export interface IndependenceDimensions {
  sourceLineage: number;
  claimContent: number;
  evidenceBase: number;
  communityOrigin: number;
  semanticFraming: number;
  temporalUpdate: number;
}

export const INDEPENDENCE_DIMENSION_KEYS = [
  'sourceLineage',
  'claimContent',
  'evidenceBase',
  'communityOrigin',
  'semanticFraming',
  'temporalUpdate',
] as const satisfies readonly (keyof IndependenceDimensions)[];

function jaccardDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
}

/**
 * Source lineage: different publisher ownership, author, wire origin, or
 * primary document (§7.4 row 1). Shared ownership dominates: an identical
 * owner chain scores 0 regardless of byline. Distinct owners with a shared
 * wire origin score 0.3 (syndication is not independence).
 */
export function sourceLineageIndependence(
  a: IndependenceFeatures,
  b: IndependenceFeatures,
): number {
  const sharedOwner = a.publisherLineage.some((owner) => b.publisherLineage.includes(owner));
  if (sharedOwner) return 0;
  if (a.wireOriginId && a.wireOriginId === b.wireOriginId) return 0.3;
  if (a.primaryDocumentId && a.primaryDocumentId === b.primaryDocumentId) return 0.5;
  if (a.authorId && a.authorId === b.authorId) return 0.2;
  return 1;
}

/** Claim content: adds a materially distinct claim or question (§7.4 row 2). */
export function claimContentIndependence(a: IndependenceFeatures, b: IndependenceFeatures): number {
  return jaccardDistance(a.claimGroupIds, b.claimGroupIds);
}

/** Evidence base: independent data/witness/document/study basis (§7.4 row 3). */
export function evidenceBaseIndependence(a: IndependenceFeatures, b: IndependenceFeatures): number {
  return jaccardDistance(a.evidenceGroupIds, b.evidenceGroupIds);
}

/** Community origin: emerges from a distinct community context (§7.4 row 4). */
export function communityOriginIndependence(
  a: IndependenceFeatures,
  b: IndependenceFeatures,
): number {
  if (!a.communityId || !b.communityId) return 0.5; // unknown origin: neutral
  return a.communityId === b.communityId ? 0 : 1;
}

/**
 * Semantic framing: a distinct explanatory frame WITHOUT being misleading
 * (§7.4 row 5). A misleading frame contributes no independence value.
 */
export function semanticFramingIndependence(
  a: IndependenceFeatures,
  b: IndependenceFeatures,
): number {
  if (a.misleading === true) return 0;
  const similarity = a.framingSimilarity ?? b.framingSimilarity;
  if (similarity === undefined) return 0.5; // no embedding available: neutral
  return Math.min(1, Math.max(0, 1 - similarity));
}

/**
 * Temporal update: adds new facts after a meaningful event update
 * (§7.4 row 6). Scales with recency separation up to `tauMs`, gated on the
 * adds-new-facts signal so a late repost of identical facts scores 0.
 */
export function temporalUpdateIndependence(
  a: IndependenceFeatures,
  b: IndependenceFeatures,
  tauMs = 6 * 3_600_000,
): number {
  if (a.addsNewFacts !== true) return 0;
  const separation = Math.abs(a.publishedAtMs - b.publishedAtMs);
  return Math.min(1, separation / tauMs);
}

/** All six dimensions for an (a, b) exposure pair. */
export function independenceDimensions(
  a: IndependenceFeatures,
  b: IndependenceFeatures,
): IndependenceDimensions {
  return {
    sourceLineage: sourceLineageIndependence(a, b),
    claimContent: claimContentIndependence(a, b),
    evidenceBase: evidenceBaseIndependence(a, b),
    communityOrigin: communityOriginIndependence(a, b),
    semanticFraming: semanticFramingIndependence(a, b),
    temporalUpdate: temporalUpdateIndependence(a, b),
  };
}

export type DimensionWeights = Record<keyof IndependenceDimensions, number>;

export const DEFAULT_DIMENSION_WEIGHTS: DimensionWeights = {
  sourceLineage: 0.3,
  claimContent: 0.2,
  evidenceBase: 0.2,
  communityOrigin: 0.1,
  semanticFraming: 0.1,
  temporalUpdate: 0.1,
};

/**
 * Combined independence ∈ [0, 1]: the weighted mean over the six dimensions.
 * Weights must be non-negative and sum to 1 (validated).
 */
export function combinedIndependence(
  dimensions: IndependenceDimensions,
  weights: DimensionWeights = DEFAULT_DIMENSION_WEIGHTS,
): number {
  let sum = 0;
  let total = 0;
  for (const key of INDEPENDENCE_DIMENSION_KEYS) {
    const w = weights[key];
    if (!Number.isFinite(w) || w < 0) throw new Error(`invalid weight for ${key}`);
    sum += w * dimensions[key];
    total += w;
  }
  if (Math.abs(total - 1) > 1e-9) throw new Error(`dimension weights must sum to 1 (got ${total})`);
  return Math.min(1, Math.max(0, sum));
}

/**
 * Which dimensions have their inputs AVAILABLE on BOTH sides of a pair. A
 * dimension whose evidence is absent is UNKNOWN — it must be excluded from the
 * mean, never scored as "fully independent". Symmetric in (a, b) so the pair
 * assessment is order-independent. Concretely:
 *  - sourceLineage / claimContent / evidenceBase need a non-empty group set on
 *    both items (an empty Jaccard set would otherwise read as distance 1);
 *  - communityOrigin needs a known community on both;
 *  - semanticFraming needs an embedding similarity, OR a definitive `misleading`
 *    verdict (which scores 0 legitimately);
 *  - temporalUpdate needs the `addsNewFacts` signal known on both (absent ⇒ the
 *    scorer would floor to 0 regardless of timing).
 */
export function availableDimensions(
  a: IndependenceFeatures,
  b: IndependenceFeatures,
): Record<keyof IndependenceDimensions, boolean> {
  return {
    sourceLineage: a.publisherLineage.length > 0 && b.publisherLineage.length > 0,
    claimContent: a.claimGroupIds.length > 0 && b.claimGroupIds.length > 0,
    evidenceBase: a.evidenceGroupIds.length > 0 && b.evidenceGroupIds.length > 0,
    communityOrigin: Boolean(a.communityId) && Boolean(b.communityId),
    semanticFraming:
      a.framingSimilarity !== undefined ||
      b.framingSimilarity !== undefined ||
      a.misleading === true ||
      b.misleading === true,
    temporalUpdate: a.addsNewFacts !== undefined && b.addsNewFacts !== undefined,
  };
}

/**
 * Symmetric, availability-aware combined independence for an UNORDERED pair, or
 * `null` when no dimension's inputs are available. Two §7.4 scorers are
 * directional (temporalUpdate reads `a.addsNewFacts`, semanticFraming reads
 * `a.misleading`), so each included dimension is averaged over both orderings;
 * weights are renormalized over the available dimensions so an absent dimension
 * neither counts as independent nor drags the mean toward 0.
 */
export function pairwiseIndependence(
  a: IndependenceFeatures,
  b: IndependenceFeatures,
  weights: DimensionWeights = DEFAULT_DIMENSION_WEIGHTS,
): number | null {
  const available = availableDimensions(a, b);
  const ab = independenceDimensions(a, b);
  const ba = independenceDimensions(b, a);
  let sum = 0;
  let wsum = 0;
  for (const key of INDEPENDENCE_DIMENSION_KEYS) {
    if (!available[key]) continue;
    const w = weights[key];
    if (!Number.isFinite(w) || w < 0) throw new Error(`invalid weight for ${key}`);
    sum += w * ((ab[key] + ba[key]) / 2);
    wsum += w;
  }
  return wsum === 0 ? null : Math.min(1, Math.max(0, sum / wsum));
}
