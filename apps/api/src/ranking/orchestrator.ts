// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.1.1d — the candidate-generation orchestrator: invokes every
// registered retriever, merges outputs into one deduplicated pool (origins
// merged, highest retrieval score retained), applies the diversity quotas
// (WS-I.1.1b) under the pool budget, and re-validates the pool against the
// strict Candidate schema at the stage boundary. A failing retriever is
// SKIPPED with a logged gap event — one broken source never takes the feed
// down. Observability: `candidate.pool.assembled` with per-origin counts and
// skipped retrievers; the orchestrator logs the `user_privacy_bucket`, never
// a raw user id.

import {
  type Candidate,
  candidatePoolSchema,
  mergeCandidates,
  type QuotaOutcome,
  type RankingProfileConfig,
} from '@licio/ranking';
import { applyQuotas, type CandidateClassification } from './quotas.js';
import type { RetrieveContext, RetrieverRegistry } from './retrievers.js';

export interface CandidatePoolResult {
  pool: Candidate[];
  quotaOutcomes: QuotaOutcome[];
  skippedRetrievers: string[];
  perOriginCounts: Record<string, number>;
}

/** Classification ports the orchestrator needs beyond retrieval. */
export interface ClassificationPorts {
  /** Source ids the user has previously seen (their OWN history only). */
  seenSourceIds(userId: string | null): Promise<Set<string>>;
  /** True when the source is a confirmed syndication COPY of another. */
  isSyndicationCopy(sourceId: string): Promise<boolean>;
}

export async function assembleCandidatePool(
  registry: RetrieverRegistry,
  classification: ClassificationPorts,
  profile: RankingProfileConfig,
  context: RetrieveContext,
  log: (event: string, meta: Record<string, unknown>) => void,
  userPrivacyBucket: string,
): Promise<CandidatePoolResult> {
  const startedAt = Date.now();
  const retrievers = registry.all();
  // Per-retriever wall-clock timing (the WS-I.1.1a latency observability):
  // each retrieval is wrapped so the completed/gap log carries duration_ms.
  const settled = await Promise.allSettled(
    retrievers.map(async (r) => {
      const t0 = Date.now();
      try {
        const candidates = await r.retrieve(context);
        return { candidates, durationMs: Date.now() - t0 };
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error('unknown'), {
          durationMs: Date.now() - t0,
        });
      }
    }),
  );

  const batches: Candidate[][] = [];
  const skippedRetrievers: string[] = [];
  settled.forEach((result, index) => {
    const origin = retrievers[index]?.origin ?? `unknown_${index}`;
    if (result.status === 'fulfilled') {
      batches.push(result.value.candidates);
      log('candidate.retrieval.completed', {
        retrieval_origin: origin,
        candidate_count: result.value.candidates.length,
        empty: result.value.candidates.length === 0,
        duration_ms: result.value.durationMs,
      });
    } else {
      // WS-I.1.1d: a failing retriever is skipped, logged, never fatal.
      skippedRetrievers.push(origin);
      const reason = result.reason as { message?: string; durationMs?: number };
      log('candidate.retrieval.gap', {
        retrieval_origin: origin,
        error: typeof reason?.message === 'string' ? reason.message : 'unknown',
        duration_ms: typeof reason?.durationMs === 'number' ? reason.durationMs : null,
      });
    }
  });

  const merged = mergeCandidates(batches);

  // Classify for quotas (fresh / independent / local).
  const seenSources = await classification.seenSourceIds(context.userId);
  const syndicationCopy = new Map<string, boolean>();
  const classify = new Map<string, CandidateClassification>();
  // Locality classifies by the MERGED origin list, not the surviving
  // `source_type`: when several retrievers produce one item, the merge keeps
  // the highest-scoring retriever's source_type but UNIONs origins — an item
  // the local retriever found is local regardless of which retriever won.
  const localOrigins = new Set(
    registry
      .all()
      .filter((retriever) => retriever.sourceType === 'local_news')
      .map((retriever) => retriever.origin),
  );
  const isLocal = (candidate: Candidate): boolean =>
    candidate.source_type === 'local_news' ||
    candidate.retrieval_origins.some((origin) => localOrigins.has(origin));
  for (const candidate of merged) {
    let independent = true;
    if (candidate.source_id !== null) {
      let copy = syndicationCopy.get(candidate.source_id);
      if (copy === undefined) {
        copy = await classification.isSyndicationCopy(candidate.source_id);
        syndicationCopy.set(candidate.source_id, copy);
      }
      independent = !copy;
    }
    classify.set(candidate.item_id, {
      fresh: candidate.source_id === null || !seenSources.has(candidate.source_id),
      independent,
      local: isLocal(candidate),
    });
  }

  const hasLocalSignal = merged.some(isLocal);
  const { pool, outcomes } = applyQuotas(
    merged,
    (candidate) =>
      classify.get(candidate.item_id) ?? { fresh: true, independent: true, local: false },
    profile.quotas,
    profile.candidate_budget,
    { localQuotaApplies: hasLocalSignal },
  );

  // Stage-boundary validation (WS-I.1.1d acceptance).
  const validated = candidatePoolSchema.parse(pool);

  const perOriginCounts: Record<string, number> = {};
  for (const candidate of validated) {
    for (const origin of candidate.retrieval_origins) {
      perOriginCounts[origin] = (perOriginCounts[origin] ?? 0) + 1;
    }
  }
  for (const outcome of outcomes) {
    log('candidate.quota.evaluated', {
      quota_type: outcome.quota_type,
      target_pct: outcome.target_pct,
      achieved_pct: outcome.achieved_pct,
      shortfall: outcome.shortfall,
      applicable: outcome.applicable,
    });
  }
  log('candidate.pool.assembled', {
    user_privacy_bucket: userPrivacyBucket,
    total_candidates: validated.length,
    per_origin_counts: perOriginCounts,
    skipped_retrievers: skippedRetrievers,
    duration_ms: Date.now() - startedAt,
  });

  return { pool: validated, quotaOutcomes: outcomes, skippedRetrievers, perOriginCounts };
}
