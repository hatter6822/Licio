// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MERI — Matroid Exposure Rank Invariant: the partition-matroid core
// (WS-H.2.2b/WS-H.2.2c, SPEC §7.2/§7.5).
//
// Model. Candidate exposures are partitioned into redundancy classes with
// per-class bounds b_c ≥ 1:
//
//   • an exact-URL class per shared canonical URL        (bound 1 — exact
//     duplicates are the strongest redundancy and never need MinHash data)
//   • a near-duplicate class per near-duplicate group   (default bound 1)
//   • a source-lineage class per shared-lineage group   (default bound 2)
//   • an evidence-lineage class per shared-evidence group(default bound 2)
//   • a singleton class for every unconstrained item    (bound 1)
//
// Each item is assigned to EXACTLY ONE class by the fixed priority
// exact-URL (when shared) > near-duplicate > source-lineage >
// evidence-lineage > singleton, so the classes genuinely partition E and
// the independence system
//
//   I = { S : |S ∩ c| ≤ b_c for every class c }
//
// is a partition matroid. When a shared exact-URL group OVERLAPS a
// near-duplicate group (some member carries the group id), the two are
// MERGED into the near-duplicate class and every URL-group member inherits
// the membership — an exact duplicate of a near-duplicate is itself a
// near-duplicate, and without the merge the URL class would shadow the
// relation and let the pair {url-member, outside-nd-member} rank 2. The
// merge is exact only while the bounds coincide (both 1); a configured
// near-duplicate bound > 1 over an overlap is a NESTED (laminar)
// constraint a flat partition cannot express, so it is refused and the
// caller takes the flagged similarity fallback rather than a silently
// wrong matroid. Its rank function is the closed form
//
//   r(S) = Σ_c min(|S ∩ c|, b_c)
//
// which is monotone and submodular (property-tested), and greedy selection
// is EXACT for matroids — the greedy basis size equals r(E), never an
// approximation (SPEC §7.2 correctness note). MERI(S) = r(S) / |S|.
//
// Fallback. When the grouping inputs fail partition validation (the same
// exposure carries contradictory group memberships — e.g. two exposures in
// one exact-URL group but different near-duplicate groups), the structure is
// NOT a matroid; `greedyIndependentSimilarity` then greedily builds an
// independent set in the general pairwise-similarity independence system and
// the result is reported as an approximation with reason code
// `MATROID_FALLBACK` (WS-H.2.2d; the standard greedy guarantees — 1−1/e for
// cardinality objectives, 1/2 under matroid constraints — are documented in
// the invariant card).

/** Redundancy-class family, in priority order. */
export type MeriClassFamily =
  | 'url_duplicate'
  | 'near_duplicate'
  | 'source_lineage'
  | 'evidence_lineage';

export interface MeriExposure {
  /** Stable exposure id (story id). */
  id: string;
  /**
   * Exact-URL identity group (post-canonicalization). Two exposures with the
   * same urlGroupId are byte-equivalent submissions of the same URL.
   */
  urlGroupId: string;
  /** MinHash/LSH near-duplicate group (WS-F dedup), when grouped. */
  nearDuplicateGroupId?: string | null | undefined;
  /** Shared publisher/ownership/wire lineage group, when known. */
  sourceLineageGroupId?: string | null | undefined;
  /** Shared primary-evidence group (claims/evidence cards), when known. */
  evidenceGroupId?: string | null | undefined;
}

export interface PartitionBounds {
  nearDuplicate: number;
  sourceLineage: number;
  evidenceLineage: number;
}

export const DEFAULT_PARTITION_BOUNDS: PartitionBounds = {
  nearDuplicate: 1,
  sourceLineage: 2,
  evidenceLineage: 2,
};

export interface PartitionClass {
  /** `family:groupId`, or `singleton:<exposureId>`. */
  classId: string;
  family: MeriClassFamily | 'singleton';
  bound: number;
  memberIds: string[];
}

export interface PartitionMatroid {
  kind: 'matroid';
  classes: PartitionClass[];
  /** exposure id → classId (a total function: the partition property). */
  classOf: Record<string, string>;
  boundOf: Record<string, number>;
}

export interface PartitionFailure {
  kind: 'failure';
  /** Human-readable validation failures (logged, never user-facing). */
  problems: string[];
}

function classFor(
  exposure: MeriExposure,
  bounds: PartitionBounds,
  sharedUrlGroups: ReadonlySet<string>,
  inheritedNearDup: ReadonlyMap<string, string>,
): { classId: string; family: PartitionClass['family']; bound: number } {
  // URL-group members inherit an overlapping near-duplicate membership
  // (merge rule, module header) — including members WITHOUT their own
  // near-duplicate group id, so the class captures outside members too.
  const inherited = inheritedNearDup.get(exposure.urlGroupId);
  if (inherited) {
    return {
      classId: `near_duplicate:${inherited}`,
      family: 'near_duplicate',
      bound: bounds.nearDuplicate,
    };
  }
  if (sharedUrlGroups.has(exposure.urlGroupId)) {
    return {
      classId: `url_duplicate:${exposure.urlGroupId}`,
      family: 'url_duplicate',
      bound: 1,
    };
  }
  if (exposure.nearDuplicateGroupId) {
    return {
      classId: `near_duplicate:${exposure.nearDuplicateGroupId}`,
      family: 'near_duplicate',
      bound: bounds.nearDuplicate,
    };
  }
  if (exposure.sourceLineageGroupId) {
    return {
      classId: `source_lineage:${exposure.sourceLineageGroupId}`,
      family: 'source_lineage',
      bound: bounds.sourceLineage,
    };
  }
  if (exposure.evidenceGroupId) {
    return {
      classId: `evidence_lineage:${exposure.evidenceGroupId}`,
      family: 'evidence_lineage',
      bound: bounds.evidenceLineage,
    };
  }
  return { classId: `singleton:${exposure.id}`, family: 'singleton', bound: 1 };
}

/**
 * Construct the partition matroid, validating that the grouping inputs are
 * consistent. Validation failures select the general similarity-graph
 * fallback (WS-H.2.2d) instead of silently mis-modelling rank.
 */
export function buildPartitionMatroid(
  exposures: readonly MeriExposure[],
  bounds: PartitionBounds = DEFAULT_PARTITION_BOUNDS,
): PartitionMatroid | PartitionFailure {
  const problems: string[] = [];
  if (bounds.nearDuplicate < 1 || bounds.sourceLineage < 1 || bounds.evidenceLineage < 1) {
    problems.push('per-class bounds must be >= 1');
  }
  const seen = new Set<string>();
  for (const exposure of exposures) {
    if (seen.has(exposure.id)) problems.push(`duplicate exposure id ${exposure.id}`);
    seen.add(exposure.id);
  }
  // Exact-URL duplicates are by definition near-duplicates: a url group
  // whose members carry two DIFFERENT near-duplicate groups is
  // contradictory grouping input — the partition would no longer model
  // "duplicate URL ⇒ zero marginal exposure" coherently, so we refuse it
  // and the caller takes the flagged similarity fallback (WS-H.2.2d).
  const urlGroupMembers = new Map<string, number>();
  const urlGroupNearDups = new Map<string, Set<string>>();
  for (const exposure of exposures) {
    urlGroupMembers.set(exposure.urlGroupId, (urlGroupMembers.get(exposure.urlGroupId) ?? 0) + 1);
    if (exposure.nearDuplicateGroupId) {
      const groupSet = urlGroupNearDups.get(exposure.urlGroupId) ?? new Set<string>();
      groupSet.add(exposure.nearDuplicateGroupId);
      urlGroupNearDups.set(exposure.urlGroupId, groupSet);
    }
  }
  for (const [urlGroupId, nearDupGroups] of urlGroupNearDups) {
    if (nearDupGroups.size > 1) {
      problems.push(`url group ${urlGroupId} spans ${nearDupGroups.size} near-duplicate classes`);
    }
  }

  const sharedUrlGroups = new Set(
    [...urlGroupMembers.entries()].filter(([, count]) => count > 1).map(([key]) => key),
  );
  // Merge rule (module header): a shared url group overlapping exactly one
  // near-duplicate group folds into it — every member inherits the
  // membership. Exact only while both bounds are 1; a larger configured
  // near-duplicate bound makes the overlap laminar, which a partition
  // cannot express — refuse rather than mis-rank.
  const inheritedNearDup = new Map<string, string>();
  for (const [urlGroupId, nearDupGroups] of urlGroupNearDups) {
    if (!sharedUrlGroups.has(urlGroupId) || nearDupGroups.size !== 1) continue;
    const [nearDupGroupId] = nearDupGroups;
    if (!nearDupGroupId) continue;
    if (bounds.nearDuplicate > 1) {
      problems.push(
        `url group ${urlGroupId} overlaps near-duplicate group ${nearDupGroupId} with bound > 1 (nested constraint; not a partition)`,
      );
      continue;
    }
    inheritedNearDup.set(urlGroupId, nearDupGroupId);
  }
  if (problems.length > 0) return { kind: 'failure', problems };

  const classes = new Map<string, PartitionClass>();
  const classOf: Record<string, string> = {};
  const boundOf: Record<string, number> = {};
  for (const exposure of exposures) {
    const { classId, family, bound } = classFor(
      exposure,
      bounds,
      sharedUrlGroups,
      inheritedNearDup,
    );
    const existing = classes.get(classId);
    if (existing) {
      existing.memberIds.push(exposure.id);
    } else {
      classes.set(classId, { classId, family, bound, memberIds: [exposure.id] });
    }
    classOf[exposure.id] = classId;
    boundOf[classId] = bound;
  }
  return {
    kind: 'matroid',
    classes: [...classes.values()],
    classOf,
    boundOf,
  };
}

/** Independence oracle: S ∈ I ⇔ ∀c, |S ∩ c| ≤ b_c. */
export function isIndependent(matroid: PartitionMatroid, subset: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const id of subset) {
    const classId = matroid.classOf[id];
    if (classId === undefined) return false;
    const next = (counts.get(classId) ?? 0) + 1;
    if (next > (matroid.boundOf[classId] ?? 1)) return false;
    counts.set(classId, next);
  }
  return true;
}

/** Exact matroid rank: r(S) = Σ_c min(|S ∩ c|, b_c). */
export function matroidRank(matroid: PartitionMatroid, subset: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const id of subset) {
    const classId = matroid.classOf[id];
    if (classId === undefined) continue;
    counts.set(classId, (counts.get(classId) ?? 0) + 1);
  }
  let rank = 0;
  for (const [classId, count] of counts) {
    rank += Math.min(count, matroid.boundOf[classId] ?? 1);
  }
  return rank;
}

/** Marginal rank gain r(S ∪ {x}) − r(S) ∈ {0, 1} (diminishing returns). */
export function marginalRankGain(
  matroid: PartitionMatroid,
  subset: readonly string[],
  candidateId: string,
): number {
  const classId = matroid.classOf[candidateId];
  if (classId === undefined) return 0;
  let inClass = 0;
  for (const id of subset) {
    if (id !== candidateId && matroid.classOf[id] === classId) inClass += 1;
  }
  return inClass < (matroid.boundOf[classId] ?? 1) ? 1 : 0;
}

/**
 * Greedy maximum independent subset in deterministic input order. For a
 * matroid the greedy result is EXACT: |basis| = r(E).
 */
export function greedyBasis(matroid: PartitionMatroid, exposureIds: readonly string[]): string[] {
  const selected: string[] = [];
  const counts = new Map<string, number>();
  for (const id of exposureIds) {
    const classId = matroid.classOf[id];
    if (classId === undefined) continue;
    const count = counts.get(classId) ?? 0;
    if (count < (matroid.boundOf[classId] ?? 1)) {
      counts.set(classId, count + 1);
      selected.push(id);
    }
  }
  return selected;
}

/** MERI(S) = r(S) / |S| ∈ (0, 1] for non-empty S (SPEC §7.2). */
export function meriScore(matroid: PartitionMatroid, subset: readonly string[]): number {
  if (subset.length === 0) return 1;
  return matroidRank(matroid, subset) / subset.length;
}

// ---------------------------------------------------------------------------
// General similarity-graph fallback (approximation; WS-H.2.2d)
// ---------------------------------------------------------------------------

export interface SimilarityEdge {
  a: string;
  b: string;
  /** Pairwise similarity in [0, 1]. */
  similarity: number;
}

export interface SimilarityFallbackResult {
  /** Greedy independent set (no selected pair exceeds the threshold). */
  selectedIds: string[];
  /** Greedy size / |E| — reported as an APPROXIMATION of normalized rank. */
  approximateScore: number;
  approximation: true;
}

/**
 * Greedy maximal independent set in the pairwise-similarity independence
 * system (independent ⇔ no selected pair with similarity ≥ threshold).
 * This general system is NOT a matroid, so the result is an approximation
 * of the largest nonredundant subset and is flagged as such.
 */
export function greedyIndependentSimilarity(
  exposureIds: readonly string[],
  edges: readonly SimilarityEdge[],
  threshold: number,
): SimilarityFallbackResult {
  const tooSimilar = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.similarity < threshold) continue;
    const setA = tooSimilar.get(edge.a) ?? new Set<string>();
    setA.add(edge.b);
    tooSimilar.set(edge.a, setA);
    const setB = tooSimilar.get(edge.b) ?? new Set<string>();
    setB.add(edge.a);
    tooSimilar.set(edge.b, setB);
  }
  const selected: string[] = [];
  const selectedSet = new Set<string>();
  for (const id of exposureIds) {
    const conflicts = tooSimilar.get(id);
    let blocked = false;
    if (conflicts) {
      for (const other of conflicts) {
        if (selectedSet.has(other)) {
          blocked = true;
          break;
        }
      }
    }
    if (!blocked) {
      selected.push(id);
      selectedSet.add(id);
    }
  }
  return {
    selectedIds: selected,
    approximateScore: exposureIds.length === 0 ? 1 : selected.length / exposureIds.length,
    approximation: true,
  };
}
