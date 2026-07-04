// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The dev-only ranking-enforcement seed makes the WS-H MERI effect actually
// apply on the dev server, so the batch outputs the dev boot + the traffic
// simulator compute reorder the served feed (the §7.1 duplicate demotion)
// instead of being silently shadow-gated. NEVER runs in production.

import { describe, expect, it } from 'vitest';
import { seedDevRankingEnforcement } from '../../lib/demo-seed.js';
import { buildSimTestGraph } from './sim-test-graph.js';

describe('seedDevRankingEnforcement', () => {
  it('is shadow-gated (MERI inert) before seeding', async () => {
    const graph = await buildSimTestGraph();
    const before = await graph.ranking.enforcement();
    expect(before.meri).toBe(false);
  });

  it('lifts MERI to soft_constraint so its ranking effect applies', async () => {
    const graph = await buildSimTestGraph();
    await seedDevRankingEnforcement(graph.invariants);
    const after = await graph.ranking.enforcement();
    expect(after.meri).toBe(true);
    // Scoped to MERI: the risky gates (GWEI whole-feed fallback, MFCI exclusion)
    // stay shadowed.
    expect(after.gwei).toBe(false);
    expect(after.mfci).toBe(false);
  });

  it('is idempotent (a re-run appends no second record)', async () => {
    const graph = await buildSimTestGraph();
    await seedDevRankingEnforcement(graph.invariants);
    await seedDevRankingEnforcement(graph.invariants);
    const rows = await graph.invariants.promotions.listForInvariant('MERI');
    expect(rows.filter((r) => r.toStatus === 'soft_constraint')).toHaveLength(1);
  });
});
