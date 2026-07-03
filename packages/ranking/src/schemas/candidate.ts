// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.1.1a/d — the `Candidate` stage-boundary schema (SPEC §13.2). Every
// retriever produces rows of this shape; the orchestrator merges, dedupes,
// quota-checks, and re-validates the pool against this STRICT schema before
// handing it to the feature-join stage. The shape is closed (`.strict()`):
// it structurally cannot carry a wallet/payment/follower field, and the
// candidate-stage financial exclusion (WS-I.1.1c) asserts that in CI.

import { z } from 'zod';

/** The eight organic candidate source types (SPEC §13.2). CLOSED set: there
 *  is deliberately no `sponsored` member — sponsored/treasury-funded content
 *  cannot enter organic retrieval (WS-I.3.1h). */
export const CANDIDATE_SOURCE_TYPES = [
  'subscribed_room',
  'local_news',
  'global',
  'emerging_discussion',
  'independent_source_addition',
  'cross_community_bridge',
  'expert_explanation',
  'chronological_catch_up',
] as const;
export type CandidateSourceType = (typeof CANDIDATE_SOURCE_TYPES)[number];
export const candidateSourceTypeSchema = z.enum(CANDIDATE_SOURCE_TYPES);

/** Feed surfaces candidate generation serves (quota + profile selectors). */
export const RANKING_SURFACES = ['front_page', 'room', 'topic'] as const;
export type RankingSurface = (typeof RANKING_SURFACES)[number];
export const rankingSurfaceSchema = z.enum(RANKING_SURFACES);

/** SCOI context metadata attached to cross-community bridge candidates. */
export const bridgeContextSchema = z
  .object({
    scoi: z.number().min(0).max(1),
    context_state: z.string().min(1).max(32),
    lens_count: z.number().int().nonnegative(),
  })
  .strict();
export type BridgeContext = z.infer<typeof bridgeContextSchema>;

/**
 * One candidate item. `retrieval_origins` is the audit trail of named
 * retrievers that produced it (merged when several did; first entry is the
 * highest-scoring origin). `retrieval_score` is the retriever's own relevance
 * heuristic in [0, 1] — it orders nothing by itself; scoring happens later.
 */
export const candidateSchema = z
  .object({
    item_id: z.string().uuid(),
    item_type: z.enum(['story', 'thread']),
    source_type: candidateSourceTypeSchema,
    room_id: z.string().uuid().nullable(),
    /** WS-Q.4.1a — item visibility (§14.5): a non-scoring ELIGIBILITY field the
     *  surface-aware distribution gate reads (it gates candidacy, never scores
     *  — proven by the WS-Q.4.3 not-a-signal property). */
    visibility: z.enum(['public', 'room_only']),
    topic_ids: z.array(z.string().min(1).max(128)).max(16),
    /** WS-F content-sensitivity labels (non-`none`), carried for the COLD-START
     *  serve: an unrevisioned item's `emptyFeatureVector` inherits these so the
     *  §11.5 sensitive-content guard fires on the FIRST serve, not only after a
     *  later feature refresh. Optional (absent ⇒ not sensitive). */
    sensitivity_labels: z.array(z.string().min(1).max(32)).max(8).optional(),
    source_id: z.string().uuid().nullable(),
    /** ISO instant used for freshness/chronological ordering. */
    freshness_timestamp: z.string(),
    retrieval_score: z.number().min(0).max(1),
    /** Named retrievers that produced this candidate (audit; merged). */
    retrieval_origins: z.array(z.string().min(1).max(64)).min(1).max(8),
    /** SCOI metadata, present on cross-community bridge candidates. */
    bridge_context: bridgeContextSchema.nullable(),
  })
  .strict();
export type Candidate = z.infer<typeof candidateSchema>;

/** Validate a merged candidate pool at the stage boundary (WS-I.1.1d). */
export const candidatePoolSchema = z.array(candidateSchema);

/**
 * Merge candidates produced by multiple retrievers into a deduplicated pool
 * keyed by `item_id` (WS-I.1.1d): origins are concatenated (deduplicated,
 * highest-scoring origin first) and the highest retrieval score is retained.
 * Deterministic: ties break on item id so identical inputs give identical
 * pools.
 */
export function mergeCandidates(batches: ReadonlyArray<readonly Candidate[]>): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const batch of batches) {
    for (const candidate of batch) {
      const existing = byId.get(candidate.item_id);
      if (existing === undefined) {
        byId.set(candidate.item_id, {
          ...candidate,
          topic_ids: [...candidate.topic_ids],
          retrieval_origins: [...candidate.retrieval_origins],
        });
        continue;
      }
      const better = candidate.retrieval_score > existing.retrieval_score;
      const origins = [
        ...new Set(
          better
            ? [...candidate.retrieval_origins, ...existing.retrieval_origins]
            : [...existing.retrieval_origins, ...candidate.retrieval_origins],
        ),
      ];
      byId.set(candidate.item_id, {
        ...(better ? candidate : existing),
        retrieval_origins: origins,
        bridge_context: existing.bridge_context ?? candidate.bridge_context,
        retrieval_score: Math.max(existing.retrieval_score, candidate.retrieval_score),
      });
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      b.retrieval_score - a.retrieval_score ||
      Date.parse(b.freshness_timestamp) - Date.parse(a.freshness_timestamp) ||
      a.item_id.localeCompare(b.item_id),
  );
}
