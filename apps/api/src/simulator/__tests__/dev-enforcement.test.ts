// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The MERI ranking-enforcement seed makes the WS-H MERI effect actually apply
// in EVERY environment, so the batch outputs the boot + the traffic simulator
// compute reorder the served feed (the §7.1 duplicate demotion) instead of
// being shadow-gated. The maintainer decision to run MERI live platform-wide.

import { describe, expect, it } from 'vitest';
import type { JobLeaseStore } from '../../identity/job-lease.js';
import { seedMeriRankingEnforcement } from '../../lib/demo-seed.js';
import { buildSimTestGraph } from './sim-test-graph.js';

describe('seedMeriRankingEnforcement', () => {
  it('is shadow-gated (MERI inert) before seeding', async () => {
    const graph = await buildSimTestGraph();
    const before = await graph.ranking.enforcement();
    expect(before.meri).toBe(false);
  });

  it('lifts MERI to soft_constraint so its ranking effect applies', async () => {
    const graph = await buildSimTestGraph();
    await seedMeriRankingEnforcement(graph.invariants);
    const after = await graph.ranking.enforcement();
    expect(after.meri).toBe(true);
    // Scoped to MERI: the risky gates (GWEI whole-feed fallback, MFCI exclusion)
    // stay shadowed.
    expect(after.gwei).toBe(false);
    expect(after.mfci).toBe(false);
  });

  it('is idempotent (a re-run appends no second record)', async () => {
    const graph = await buildSimTestGraph();
    await seedMeriRankingEnforcement(graph.invariants);
    await seedMeriRankingEnforcement(graph.invariants);
    const rows = await graph.invariants.promotions.listForInvariant('MERI');
    expect(rows.filter((r) => r.toStatus === 'soft_constraint')).toHaveLength(1);
  });

  it('still enforces MERI when the lease is denied (fail-open, at-least-once)', async () => {
    // The lease only DEDUPES concurrent first-boots; correctness must never
    // depend on it. A replica that never wins the lease (and no row exists yet)
    // must still append, or a lease outage could leave MERI shadow-gated.
    const graph = await buildSimTestGraph();
    const denyLease: JobLeaseStore = { tryAcquire: async () => false };
    await seedMeriRankingEnforcement(graph.invariants, denyLease);
    const after = await graph.ranking.enforcement();
    expect(after.meri).toBe(true);
  });

  it('a throwing lease fails open (still enforces, no duplicate on re-run)', async () => {
    const graph = await buildSimTestGraph();
    const throwLease: JobLeaseStore = {
      tryAcquire: async () => {
        throw new Error('lease store unavailable');
      },
    };
    await seedMeriRankingEnforcement(graph.invariants, throwLease);
    await seedMeriRankingEnforcement(graph.invariants, throwLease);
    expect((await graph.ranking.enforcement()).meri).toBe(true);
    const rows = await graph.invariants.promotions.listForInvariant('MERI');
    expect(rows.filter((r) => r.toStatus === 'soft_constraint')).toHaveLength(1);
  });
});
