// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H performance benchmarks — RUN_PERF-gated (the WS-F precedent): these
// run heavy kernels at production-like sizes and assert the batch-tier
// budgets the invariant cards and the scheduler assume, so the operating
// point is MEASURED, not presumed. They never run in CI or a normal pass:
//
//   RUN_PERF=1 pnpm --filter @licio/invariants test performance
//
// Budgets are per-invariant batch-call ceilings well inside the scheduler's
// wrapperTimeoutMs default; failures mean the production sizes need a
// smaller cap or a faster kernel, BEFORE a TIMEOUT degrades real outputs.
import { describe, expect, it } from 'vitest';
import {
  buildMetricMeasureSpace,
  buildSparseTable,
  buildTopicStructure,
  computeMeri,
  fiberTestMulti,
  gwDistanceWithStability,
  helmholtzDecompose,
  jacobiEigSym,
  loopHolonomy,
  type MeriCandidateInput,
  MFCI_AXES,
  type TopicStructure,
} from '../index.js';
import { mulberry32 } from '../math/rng.js';

// The invariants package compiles with no node ambient types (pure math);
// the gate and reporter go through globalThis with narrow local types.
const RUN_PERF =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'RUN_PERF'
  ] === '1';

const report = (message: string): void => {
  (globalThis as { console?: { log(m: string): void } }).console?.log(message);
};

function timed<T>(work: () => T): { result: T; ms: number } {
  const start = Date.now();
  const result = work();
  return { result, ms: Date.now() - start };
}

describe.skipIf(!RUN_PERF)('WS-H batch-tier performance (RUN_PERF)', () => {
  it('MERI: 200 candidates with grouped structure under 250 ms', () => {
    const rng = mulberry32(1);
    const candidates: MeriCandidateInput[] = Array.from({ length: 200 }, (_, i) => ({
      id: `story-${i}`,
      urlGroupId: `url-${i}`,
      nearDuplicateGroupId: rng() < 0.3 ? `nd-${i % 20}` : null,
      sourceLineageGroupId: rng() < 0.4 ? `src-${i % 12}` : null,
      evidenceGroupId: rng() < 0.2 ? `ev-${i % 8}` : null,
      claimGroupId: null,
      framingGroupId: null,
      misleading: false,
      inputsAvailable: {
        canonicalUrl: true,
        claimExtraction: true,
        sourceLineage: true,
        evidence: true,
        embedding: true,
      },
    }));
    const { result, ms } = timed(() => computeMeri(candidates));
    expect(result.meri).toBeGreaterThan(0);
    expect(ms).toBeLessThan(250);
    report(`MERI 200 candidates: ${ms.toFixed(1)} ms (meri ${result.meri.toFixed(3)})`);
  });

  it('MFCI: production sampler settings over a 60-target window under 12 s', () => {
    const rng = mulberry32(2);
    const targets = Array.from({ length: 60 }, (_, i) => `t-${i}`);
    const groups = ['new', 'recent', 'established'];
    const topics = ['water', 'transit', 'zoning', 'budget'];
    const buckets = Array.from({ length: 6 }, (_, i) => `b${i}`);
    const actions = ['contribution.created', 'content.submitted'];
    const observations = Array.from({ length: 800 }, () => ({
      labels: [
        groups[Math.floor(rng() * groups.length)] ?? 'new',
        topics[Math.floor(rng() * topics.length)] ?? 'water',
        buckets[Math.floor(rng() * buckets.length)] ?? 'b0',
        actions[Math.floor(rng() * actions.length)] ?? 'contribution.created',
        targets[Math.floor(rng() * targets.length)] ?? 't-0',
      ],
    }));
    const table = buildSparseTable(
      [
        { name: MFCI_AXES[0], labels: groups },
        { name: MFCI_AXES[1], labels: topics },
        { name: MFCI_AXES[2], labels: buckets },
        { name: MFCI_AXES[3], labels: actions },
        { name: MFCI_AXES[4], labels: targets },
      ],
      observations,
    );
    // The production defaults: samples 2000, burnIn 2000, thinning 2.
    const { result, ms } = timed(() =>
      fiberTestMulti(table, 'target_concentration', targets, {
        samples: 2_000,
        burnIn: 2_000,
        thinning: 2,
        seed: 7,
      }),
    );
    expect(result.perTarget).toHaveLength(60);
    expect(ms).toBeLessThan(12_000);
    report(
      `MFCI 800 obs × 60 targets @ production sampler: ${ms.toFixed(0)} ms (ESS ${result.effectiveSampleSize.toFixed(0)})`,
    );
  });

  it('GWEI: 50×50 item spaces across a 3-seed × 2-epsilon stability grid under 20 s', () => {
    const rng = mulberry32(3);
    const mkSpace = (offset: number) =>
      buildMetricMeasureSpace(
        Array.from({ length: 50 }, (_, i) => ({
          itemId: `item-${offset}-${i}`,
          semantic: Array.from({ length: 16 }, () => rng() * 2 - 1),
          sourceKey: `s-${(i + offset) % 9}`,
          evidenceKeys: i % 3 === 0 ? [`e-${i % 5}`] : [],
          communityKeys: [`c-${i % 4}`],
          weight: 1 + rng(),
        })),
      );
    const a = mkSpace(0);
    const b = mkSpace(1);
    const { result, ms } = timed(() =>
      gwDistanceWithStability(a, b, {
        seeds: [0, 1, 2],
        epsilons: [0.05, 0.1],
        outerIterations: 25,
      }),
    );
    expect(Number.isFinite(result.gw2)).toBe(true);
    expect(ms).toBeLessThan(20_000);
    report(`GWEI 50×50 stability grid: ${ms.toFixed(0)} ms (gw2 ${result.gw2.toFixed(3)})`);
  });

  it('PHI: 40 topic structures + a 12-leg loop under 2 s', () => {
    const rng = mulberry32(4);
    const structures = new Map<string, TopicStructure>();
    const { ms: buildMs } = timed(() => {
      for (let t = 0; t < 40; t += 1) {
        const cloud = Array.from({ length: 32 }, () =>
          Array.from({ length: 8 }, () => rng() * 2 - 1),
        );
        const structure = buildTopicStructure(`topic-${t}`, cloud);
        if (structure) structures.set(`topic-${t}`, structure);
      }
    });
    expect(structures.size).toBe(40);
    const loop = [...Array.from({ length: 12 }, (_, i) => `topic-${i % 11}`), 'topic-0'];
    const { result, ms } = timed(() => loopHolonomy(structures, loop));
    expect(result).not.toBeNull();
    expect(buildMs + ms).toBeLessThan(2_000);
    report(
      `PHI 40 structures + 12-leg loop: build ${buildMs.toFixed(0)} ms, holonomy ${ms.toFixed(1)} ms`,
    );
  });

  it('Hodge: a 300-edge conversation complex under 2 s', () => {
    const rng = mulberry32(5);
    const vertices = Array.from({ length: 60 }, (_, i) => `u${i}`);
    const edges = Array.from({ length: 300 }, () => {
      const a = Math.floor(rng() * vertices.length);
      let b = Math.floor(rng() * vertices.length);
      if (b === a) b = (b + 1) % vertices.length;
      return { from: vertices[a] ?? 'u0', to: vertices[b] ?? 'u1', flow: rng() * 2 - 1 };
    });
    // Dedup parallel edges (the complex builder expects simple edges).
    const seen = new Set<string>();
    const simple = edges.filter((e) => {
      const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const { result, ms } = timed(() =>
      helmholtzDecompose({ vertices, edges: simple, triangles: [] }),
    );
    expect(Number.isFinite(result.harmonicFraction)).toBe(true);
    expect(ms).toBeLessThan(2_000);
    report(`Hodge ${simple.length} edges: ${ms.toFixed(0)} ms`);
  });

  it('Jacobi eigendecomposition at d=32 under 250 ms', () => {
    const rng = mulberry32(6);
    const raw = Array.from({ length: 32 }, () => Array.from({ length: 32 }, () => rng() * 2 - 1));
    const symmetric = raw.map((row, i) => row.map((v, j) => (v + (raw[j]?.[i] ?? 0)) / 2));
    const { result, ms } = timed(() => jacobiEigSym(symmetric));
    expect(result.values).toHaveLength(32);
    expect(ms).toBeLessThan(250);
    report(`Jacobi d=32: ${ms.toFixed(1)} ms`);
  });
});
