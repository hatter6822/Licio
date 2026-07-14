// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reeb Attention Landscape (WS-H.7.4, SPEC §12.4).
//
// The scalar function (engagement velocity, controversy, or any configured
// metric) lives on a content-similarity graph. The landscape is decomposed
// into the standard pair of merge trees:
//
//   • JOIN TREE — descending superlevel sweep {value ≥ ℓ}: a component
//     birth is a local PEAK (an attention basin appearing); two components
//     joining is a SADDLE (two basins connecting). A saddle is FRAGILE when
//     few edges connect the merging basins at the merge level — exactly
//     where a bridge prompt is routed (WS-H.7.4b).
//   • SPLIT TREE — the same sweep on the negated function: its merge
//     events, read back on the original function, are the BIFURCATIONS
//     (one basin separating into two as the function value descends).
//
// Saddle semantics: a union of two components is a merge EVENT only when
// both components were born strictly above the current level (both peaks >
// level). A newborn node attaching to an existing basin is growth; two
// same-level nodes connecting on a plateau form one basin, not a saddle.
// Basins carry stable names — the highest-value member (ties: smaller id) —
// so identity persists across levels. Union-find keeps the sweep
// near-linear; the per-merge connecting-edge count is an O(E) scan.

export interface ReebNode {
  id: string;
  value: number;
}

export interface ReebEdge {
  a: string;
  b: string;
}

export interface ReebMergeEvent {
  level: number;
  /** Stable basin names (peak node ids) that joined. */
  basinA: string;
  basinB: string;
  /** The surviving basin name after the join. */
  survivor: string;
  /** Edges connecting the two basins at the merge level. */
  connectingEdges: number;
  fragile: boolean;
}

export interface ReebGraphResult {
  /** Basin births: every local peak, with its level. */
  peaks: Array<{ basin: string; level: number }>;
  /** Join-tree saddles: two basins becoming one (descending). */
  merges: ReebMergeEvent[];
  /** Split-tree events: one basin becoming two (descending direction). */
  splits: ReebMergeEvent[];
  /** Basins still distinct after the full sweep. */
  finalBasins: string[];
  /** Fragile saddles → bridge prompts (WS-H.7.4b). */
  bridgePrompts: Array<{ basinA: string; basinB: string; level: number }>;
}

export interface ReebOptions {
  /** Connecting-edge count at or below which a saddle is fragile. */
  fragileEdgeThreshold: number;
}

export const DEFAULT_REEB_OPTIONS: ReebOptions = { fragileEdgeThreshold: 1 };

interface SweepResult {
  peaks: Array<{ basin: string; level: number }>;
  merges: ReebMergeEvent[];
  finalBasins: string[];
}

function sweep(
  nodes: readonly ReebNode[],
  edges: readonly ReebEdge[],
  options: ReebOptions,
): SweepResult {
  const nodeValue = new Map(nodes.map((n) => [n.id, n.value]));
  for (const edge of edges) {
    if (!nodeValue.has(edge.a) || !nodeValue.has(edge.b)) {
      throw new Error(`edge references unknown node ${edge.a}/${edge.b}`);
    }
  }
  const parent = new Map<string, string>();
  const peakOf = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    let walk = x;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk) ?? root;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  /** Higher value wins; ties go to the smaller id (deterministic). */
  const dominantPeak = (a: string, b: string): string => {
    const va = nodeValue.get(a) ?? Number.NEGATIVE_INFINITY;
    const vb = nodeValue.get(b) ?? Number.NEGATIVE_INFINITY;
    if (va > vb) return a;
    if (vb > va) return b;
    return a < b ? a : b;
  };

  // Codepoint order, NOT localeCompare: this sweep fixes merge pairing and
  // `connectingEdges` when ≥3 basins join, so its ordering must be deterministic
  // across runtimes/ICU versions (the same rule cid/index.ts pins). ASCII ids
  // are unaffected; non-ASCII ids would otherwise be locale-dependent.
  const cp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const sortedNodes = [...nodes].sort((x, y) => y.value - x.value || cp(x.id, y.id));
  const levels = [...new Set(sortedNodes.map((n) => n.value))].sort((a, b) => b - a);
  const sortedEdges = [...edges].sort((x, y) => cp(x.a, y.a) || cp(x.b, y.b));

  const active = new Set<string>();
  const peaks: Array<{ basin: string; level: number }> = [];
  const merges: ReebMergeEvent[] = [];
  let cursor = 0;

  for (const level of levels) {
    const activatedNow: string[] = [];
    while (cursor < sortedNodes.length && (sortedNodes[cursor]?.value ?? -Infinity) >= level) {
      const node = sortedNodes[cursor];
      cursor += 1;
      if (!node || active.has(node.id)) continue;
      active.add(node.id);
      parent.set(node.id, node.id);
      peakOf.set(node.id, node.id);
      activatedNow.push(node.id);
    }

    // Union across every active edge joining two distinct components.
    for (const edge of sortedEdges) {
      if (!active.has(edge.a) || !active.has(edge.b)) continue;
      const rootA = find(edge.a);
      const rootB = find(edge.b);
      if (rootA === rootB) continue;
      const peakA = peakOf.get(rootA) ?? rootA;
      const peakB = peakOf.get(rootB) ?? rootB;
      const bothBornAbove =
        (nodeValue.get(peakA) ?? level) > level && (nodeValue.get(peakB) ?? level) > level;
      if (bothBornAbove) {
        let connecting = 0;
        for (const candidate of sortedEdges) {
          if (!active.has(candidate.a) || !active.has(candidate.b)) continue;
          const ra = find(candidate.a);
          const rb = find(candidate.b);
          if ((ra === rootA && rb === rootB) || (ra === rootB && rb === rootA)) connecting += 1;
        }
        const survivor = dominantPeak(peakA, peakB);
        merges.push({
          level,
          basinA: peakA,
          basinB: peakB,
          survivor,
          connectingEdges: connecting,
          fragile: connecting <= options.fragileEdgeThreshold,
        });
      }
      parent.set(rootA, rootB);
      peakOf.set(find(rootB), dominantPeak(peakA, peakB));
    }

    // Births: components whose peak sits at this level are new basins.
    const born = new Set<string>();
    for (const id of activatedNow) {
      const root = find(id);
      const peak = peakOf.get(root) ?? root;
      if ((nodeValue.get(peak) ?? Number.NEGATIVE_INFINITY) === level && !born.has(peak)) {
        born.add(peak);
        peaks.push({ basin: peak, level });
      }
    }
  }

  const finalBasins = [...new Set([...active].map((id) => peakOf.get(find(id)) ?? id))].sort();
  return { peaks, merges, finalBasins };
}

/** The Reeb landscape: join tree + split tree (see module header). */
export function reebGraph(
  nodes: readonly ReebNode[],
  edges: readonly ReebEdge[],
  options: ReebOptions = DEFAULT_REEB_OPTIONS,
): ReebGraphResult {
  const descending = sweep(nodes, edges, options);
  const ascending = sweep(
    nodes.map((n) => ({ id: n.id, value: -n.value })),
    edges,
    options,
  );
  const splits = ascending.merges.map((m) => ({ ...m, level: -m.level }));
  return {
    peaks: descending.peaks,
    merges: descending.merges,
    splits,
    finalBasins: descending.finalBasins,
    bridgePrompts: descending.merges
      .filter((m) => m.fragile)
      .map((m) => ({ basinA: m.basinA, basinB: m.basinB, level: m.level })),
  };
}

export const REEB_VERSION = '1.0.0';
