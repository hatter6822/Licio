// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.4a/b — matroid dedup + source/topic/lens balancing.

import { describe, expect, it } from 'vitest';
import { applyBalancing, type BalancingInput } from '../diversify/balancing.js';
import { applyMatroidDedup, type DedupInput } from '../diversify/dedup.js';
import { uuidOf } from './fixtures.js';

function dedupItem(n: number, score: number, clusterId: string | null): DedupInput {
  return { itemId: uuidOf(n), score, clusterId };
}

describe('WS-I.2.4a matroid dedup', () => {
  it('caps one cluster at n per page; the highest-scoring members stay', () => {
    const items = Array.from({ length: 10 }, (_, i) => dedupItem(i + 1, 1 - i * 0.05, 'c1'));
    const result = applyMatroidDedup(items, 2);
    expect(result.kept).toHaveLength(2);
    expect(result.kept.map((k) => k.itemId)).toEqual([uuidOf(1), uuidOf(2)]);
    expect(result.expansions.get('c1')).toHaveLength(8);
    expect(result.largestClusterSize).toBe(10);
    expect(result.applications).toHaveLength(8);
    expect(result.applications[0]?.action).toBe('demoted');
  });

  it('unique items (no cluster) are unconstrained', () => {
    const items = Array.from({ length: 5 }, (_, i) => dedupItem(i + 1, 1 - i * 0.1, null));
    const result = applyMatroidDedup(items, 1);
    expect(result.kept).toHaveLength(5);
    expect(result.expansions.size).toBe(0);
  });

  it('a cluster with exactly n members keeps all n', () => {
    const result = applyMatroidDedup([dedupItem(1, 0.9, 'c1'), dedupItem(2, 0.8, 'c1')], 2);
    expect(result.kept).toHaveLength(2);
    expect(result.expansions.size).toBe(0);
  });

  it('demoted items remain available for "more on this story" expansion', () => {
    const result = applyMatroidDedup(
      [dedupItem(1, 0.9, 'c1'), dedupItem(2, 0.8, 'c1'), dedupItem(3, 0.7, 'c1')],
      2,
    );
    expect(result.expansions.get('c1')?.map((i) => i.itemId)).toEqual([uuidOf(3)]);
  });

  it('a degenerate cap clamps to 1 (never zero — something always serves)', () => {
    const result = applyMatroidDedup([dedupItem(1, 0.9, 'c1'), dedupItem(2, 0.8, 'c1')], 0);
    expect(result.kept).toHaveLength(1);
  });
});

function balanceItem(
  n: number,
  score: number,
  sourceId: string | null,
  topicIds: string[] = ['t'],
  lensId: string | null = null,
): BalancingInput {
  return { itemId: uuidOf(n), score, sourceId, topicIds, lensId };
}

const CONFIG = {
  pageSize: 10,
  maxSourceSharePct: 20, // 2 of 10
  maxTopicSharePct: 30, // 3 of 10
  minDistinctLenses: 2,
  phiTighten: false,
};

describe('WS-I.2.4b balancing', () => {
  it('caps a dominating source and backfills from other sources', () => {
    const pool = [
      ...Array.from({ length: 6 }, (_, i) =>
        balanceItem(i + 1, 1 - i * 0.01, uuidOf(900), [`t${i}`]),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        balanceItem(i + 10, 0.5 - i * 0.01, uuidOf(901 + i), [`u${i}`]),
      ),
    ];
    const result = applyBalancing(pool, CONFIG);
    const fromDominant = result.page.filter((p) => p.sourceId === uuidOf(900));
    expect(fromDominant).toHaveLength(2);
    expect(result.page).toHaveLength(10);
    expect(result.degraded).toBe(false);
    expect(result.demoted.some((d) => d.sourceId === uuidOf(900))).toBe(true);
    expect(
      result.applications.some(
        (a) => a.constraint === 'source_share_cap' && a.action === 'demoted',
      ),
    ).toBe(true);
  });

  it('caps a dominating topic cluster', () => {
    const pool = [
      ...Array.from({ length: 6 }, (_, i) =>
        balanceItem(i + 1, 1 - i * 0.01, uuidOf(900 + i), ['hot']),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        balanceItem(i + 10, 0.5 - i * 0.01, uuidOf(920 + i), [`u${i}`]),
      ),
    ];
    const result = applyBalancing(pool, CONFIG);
    const hot = result.page.filter((p) => p.topicIds.includes('hot'));
    expect(hot).toHaveLength(3);
  });

  it('degrades gracefully when one source dominates the whole pool (logged)', () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      balanceItem(i + 1, 1 - i * 0.01, uuidOf(900), [`t${i}`]),
    );
    const result = applyBalancing(pool, CONFIG);
    // A short page is worse than an imbalanced one: the page still fills.
    expect(result.page).toHaveLength(10);
    expect(result.degraded).toBe(true);
    expect(result.applications.some((a) => a.constraint === 'source_share_cap_degraded')).toBe(
      true,
    );
  });

  it('PHI tightening halves the topic cap', () => {
    const pool = [
      ...Array.from({ length: 4 }, (_, i) =>
        balanceItem(i + 1, 1 - i * 0.01, uuidOf(900 + i), ['narrow']),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        balanceItem(i + 10, 0.5 - i * 0.01, uuidOf(920 + i), [`u${i}`]),
      ),
    ];
    const normal = applyBalancing(pool, CONFIG);
    const tightened = applyBalancing(pool, { ...CONFIG, phiTighten: true });
    const narrowNormal = normal.page.filter((p) => p.topicIds.includes('narrow')).length;
    const narrowTight = tightened.page.filter((p) => p.topicIds.includes('narrow')).length;
    expect(narrowTight).toBeLessThan(narrowNormal);
  });

  it('lens balancing promotes an unrepresented lens when available', () => {
    const pool = [
      balanceItem(1, 0.9, uuidOf(901), ['a'], 'lens-1'),
      balanceItem(2, 0.8, uuidOf(902), ['b'], 'lens-1'),
      balanceItem(3, 0.1, uuidOf(903), ['c'], 'lens-2'),
    ];
    const result = applyBalancing(pool, { ...CONFIG, pageSize: 2 });
    const lensesOnPage = new Set(result.page.map((p) => p.lensId));
    expect(lensesOnPage.has('lens-1')).toBe(true);
    expect(lensesOnPage.has('lens-2')).toBe(true);
    expect(result.applications.some((a) => a.constraint === 'lens_representation')).toBe(true);
  });

  // The graceful-degradation fill APPENDS over-cap items, so a degraded page is
  // not in score order. Choosing the eviction by POSITION therefore dropped the
  // strongest eligible item and kept a much weaker one; it must choose by SCORE.
  it('lens promotion evicts the lowest-SCORING eligible item on a degraded page', () => {
    const pool = [
      balanceItem(1, 0.9, uuidOf(900), ['a'], 'lens-1'),
      balanceItem(2, 0.8, uuidOf(900), ['b'], 'lens-1'), // deferred by the source cap
      balanceItem(3, 0.2, uuidOf(901), ['c'], 'lens-1'),
      balanceItem(4, 0.1, uuidOf(900), ['d'], 'lens-2'), // deferred; lens-promoted
    ];
    const result = applyBalancing(pool, {
      ...CONFIG,
      pageSize: 3,
      maxSourceSharePct: 34, // 1 of 3 → items 2 and 4 defer, then 2 back-fills
    });
    expect(result.degraded).toBe(true);
    const served = result.page.map((p) => p.itemId);
    // The 0.8 item stays; the 0.2 item is the one that makes way for the lens.
    expect(served).toContain(uuidOf(2));
    expect(served).not.toContain(uuidOf(3));
    expect(result.demoted.map((d) => d.itemId)).toContain(uuidOf(3));
    // Lens representation is still achieved, and the page stays score-ordered.
    expect(new Set(result.page.map((p) => p.lensId))).toEqual(new Set(['lens-1', 'lens-2']));
    expect(result.page.map((p) => p.score)).toEqual(
      [...result.page.map((p) => p.score)].sort((a, b) => b - a),
    ); // prettier-ignore
  });

  it('never lists a served item as demoted, even when a cap-demoted item is lens-promoted', () => {
    // Source 900 fills the 2-slot page (cap 1/source), pushing the low-score
    // lens-2 item (same source) out via the source cap.  The lens loop then
    // promotes that lens-2 item back onto the page: it must NOT stay demoted,
    // and the item it evicted must be recorded as the demotion.
    const pool = [
      balanceItem(1, 0.9, uuidOf(900), ['a'], 'lens-1'),
      balanceItem(2, 0.8, uuidOf(900), ['b'], 'lens-1'),
      balanceItem(3, 0.1, uuidOf(900), ['c'], 'lens-2'),
    ];
    const result = applyBalancing(pool, { ...CONFIG, pageSize: 2, maxSourceSharePct: 50 });

    const pageIds = new Set(result.page.map((p) => p.itemId));
    const demotedIds = new Set(result.demoted.map((d) => d.itemId));
    // (a) page and demoted are disjoint — a served item is never also demoted.
    for (const id of pageIds) expect(demotedIds.has(id)).toBe(false);
    // (b) no served item carries a `demoted` application.
    const demotedAppItems = new Set(
      result.applications.filter((a) => a.action === 'demoted').map((a) => a.item_id),
    );
    for (const id of pageIds) expect(demotedAppItems.has(id)).toBe(false);
    // (c) the promoted lens-2 item is served; the evicted item is the demotion.
    expect(pageIds.has(uuidOf(3))).toBe(true);
    expect(result.applications.some((a) => a.item_id === uuidOf(2) && a.action === 'demoted')).toBe(
      true,
    );
  });

  it('is deterministic: identical input gives identical pages', () => {
    const pool = Array.from({ length: 20 }, (_, i) =>
      balanceItem(i + 1, 1 - i * 0.01, uuidOf(900 + (i % 4)), [`t${i % 3}`]),
    );
    const a = applyBalancing(pool, CONFIG).page.map((p) => p.itemId);
    const b = applyBalancing(pool, CONFIG).page.map((p) => p.itemId);
    expect(a).toEqual(b);
  });
});
