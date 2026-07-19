// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.4b — source, topic, and lens balancing (SPEC §13.4). After matroid
// dedup, no single source (publisher) may exceed `max_source_share_pct` of
// the page, no topic cluster may exceed `max_topic_share_pct`, and room feeds
// with multiple active lenses must represent at least `min_distinct_lenses`
// when available. Excess items are DEMOTED (pushed below the page boundary,
// replaced by the next-highest item from an under-represented source/topic),
// never removed. When the pool itself is dominated (a major breaking event),
// the pass degrades gracefully: it fills the page anyway and logs the
// imbalance rather than serving a short page.
//
// Balancing reads publisher/domain and topic identity ONLY — there is no
// financial input to this stage by construction.

import type { ConstraintApplication } from '../schemas/decision-log.js';

export interface BalancingInput {
  itemId: string;
  score: number;
  sourceId: string | null;
  topicIds: readonly string[];
  lensId: string | null;
}

export interface BalancingConfig {
  pageSize: number;
  maxSourceSharePct: number;
  maxTopicSharePct: number;
  minDistinctLenses: number;
  /** PHI diversification (WS-I.2.3c): tighten topic caps for this request. */
  phiTighten: boolean;
}

export interface BalancingResult {
  /** The balanced page (≤ pageSize), descending score within constraints. */
  page: BalancingInput[];
  /** Items demoted below the page boundary by a balancing rule. */
  demoted: BalancingInput[];
  applications: ConstraintApplication[];
  /** True when caps could not be met from the available pool. */
  degraded: boolean;
}

const sharePctToCount = (pct: number, pageSize: number): number =>
  Math.max(1, Math.floor((pct / 100) * pageSize));

/**
 * Greedy balanced selection: walk the score-ordered pool; admit an item when
 * it violates no share cap; otherwise defer it. A second fill pass admits
 * deferred items if the page is still short (graceful degradation — a short
 * page is worse than an imbalanced one, and the imbalance is logged).
 * Deterministic: input order is the (already deterministic) score order.
 */
export function applyBalancing(
  pool: readonly BalancingInput[],
  config: BalancingConfig,
): BalancingResult {
  const pageSize = Math.max(1, Math.floor(config.pageSize));
  // PHI diversification tightens the topic cap by half (stricter spread).
  const topicSharePct = config.phiTighten
    ? Math.max(1, Math.floor(config.maxTopicSharePct / 2))
    : config.maxTopicSharePct;
  const maxPerSource = sharePctToCount(config.maxSourceSharePct, pageSize);
  const maxPerTopic = sharePctToCount(topicSharePct, pageSize);

  const sourceCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const page: BalancingInput[] = [];
  const deferred: Array<{ item: BalancingInput; rule: 'source' | 'topic' }> = [];
  const applications: ConstraintApplication[] = [];

  const admit = (item: BalancingInput): void => {
    page.push(item);
    if (item.sourceId !== null) {
      sourceCounts.set(item.sourceId, (sourceCounts.get(item.sourceId) ?? 0) + 1);
    }
    for (const topic of item.topicIds) {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
  };

  for (const item of pool) {
    if (page.length >= pageSize) break;
    const sourceFull =
      item.sourceId !== null && (sourceCounts.get(item.sourceId) ?? 0) >= maxPerSource;
    const topicFull = item.topicIds.some((topic) => (topicCounts.get(topic) ?? 0) >= maxPerTopic);
    if (sourceFull || topicFull) {
      deferred.push({ item, rule: sourceFull ? 'source' : 'topic' });
      continue;
    }
    admit(item);
  }

  // Graceful degradation: fill remaining slots from deferred items in score
  // order, logging each over-cap admission.
  let degraded = false;
  for (const { item, rule } of deferred) {
    if (page.length >= pageSize) break;
    degraded = true;
    applications.push({
      constraint: rule === 'source' ? 'source_share_cap_degraded' : 'topic_share_cap_degraded',
      item_id: item.itemId,
      threshold: rule === 'source' ? config.maxSourceSharePct : topicSharePct,
      actual: rule,
      // This item IS admitted (over-cap graceful fill), so it is NOT demoted;
      // the `*_degraded` constraint name conveys the over-cap admission.
      action: 'diversified',
      enforced: true,
    });
    admit(item);
  }

  const admitted = new Set(page.map((p) => p.itemId));
  const demoted: BalancingInput[] = [];
  for (const { item, rule } of deferred) {
    if (admitted.has(item.itemId)) continue;
    demoted.push(item);
    applications.push({
      constraint: rule === 'source' ? 'source_share_cap' : 'topic_share_cap',
      item_id: item.itemId,
      threshold: rule === 'source' ? config.maxSourceSharePct : topicSharePct,
      actual: rule,
      action: 'demoted',
      enforced: true,
    });
  }
  // Pool items beyond the page boundary (no rule violated, just lower score)
  // are not "demoted" — they simply did not make the page.

  // --- Lens representation (room feeds): when ≥ minDistinctLenses lenses
  // exist in the pool but the page covers fewer, promote the best item of an
  // unrepresented lens over the page's lowest non-unique-lens item.
  const lensesInPool = new Set(
    pool.map((p) => p.lensId).filter((lens): lens is string => lens !== null),
  );
  if (lensesInPool.size >= 2 && config.minDistinctLenses >= 2) {
    const wanted = Math.min(config.minDistinctLenses, lensesInPool.size);
    const lensesOnPage = () =>
      new Set(page.map((p) => p.lensId).filter((lens): lens is string => lens !== null));
    let guard = 0;
    while (lensesOnPage().size < wanted && guard < pool.length) {
      guard += 1;
      const present = lensesOnPage();
      const candidate = pool.find(
        (p) =>
          p.lensId !== null && !present.has(p.lensId) && !page.some((q) => q.itemId === p.itemId),
      );
      if (candidate === undefined) break;
      // Replace the lowest-scoring page item whose lens is over-represented
      // (appears more than once) or is null; never drop the only item of a lens.
      const replaceable = [...page]
        .reverse()
        .find((p) => p.lensId === null || page.filter((q) => q.lensId === p.lensId).length > 1);
      if (replaceable === undefined) break;
      page.splice(page.indexOf(replaceable), 1);
      demoted.push(replaceable);
      // Record BOTH: why the lens was promoted (candidate entered) AND that the
      // evicted page item (replaceable) was demoted — so the audit log names the
      // item that actually left the page, not only the one that entered.
      applications.push({
        constraint: 'lens_representation',
        item_id: candidate.itemId,
        threshold: wanted,
        actual: present.size,
        action: 'diversified',
        enforced: true,
      });
      applications.push({
        constraint: 'lens_representation',
        item_id: replaceable.itemId,
        threshold: wanted,
        actual: present.size,
        action: 'demoted',
        enforced: true,
      });
      // If this promoted candidate had been demoted earlier by a source/topic
      // cap, it is now SERVED: clear its stale demotion from both the list and
      // the log so a served item never appears as demoted.
      const priorDemotionIdx = demoted.findIndex((d) => d.itemId === candidate.itemId);
      if (priorDemotionIdx !== -1) {
        demoted.splice(priorDemotionIdx, 1);
        const staleAppIdx = applications.findIndex(
          (a) =>
            a.item_id === candidate.itemId &&
            (a.constraint === 'source_share_cap' || a.constraint === 'topic_share_cap'),
        );
        if (staleAppIdx !== -1) applications.splice(staleAppIdx, 1);
      }
      admit(candidate);
    }
  }

  // Keep the served page score-ordered on EVERY path (stable, deterministic) —
  // the graceful-degradation fill and non-lens surfaces skip the lens-promotion
  // block above, so sorting only there left those pages out of score order.
  page.sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));
  return { page, demoted, applications, degraded };
}
