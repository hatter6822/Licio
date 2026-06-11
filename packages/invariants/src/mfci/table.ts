// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MFCI — sparse contingency tables and fixed margins
// (WS-H.3.2a/WS-H.3.2b, SPEC §8.2).
//
// The observed table X counts actions over the five SPEC dimensions
// user_group × topic × time_bucket × action_type × target. Cells are sparse
// (Map keyed by the index tuple); margins are the per-axis 1-way totals —
// exactly the sufficient statistics of the complete-independence log-linear
// null, so conditioning on them is conditioning on "group size, topic
// popularity, temporal pattern, action mix, and baseline target popularity"
// (MFCI-1: a large normal community's volume lives entirely in its margins).

export interface AxisDef {
  name: string;
  labels: readonly string[];
}

/** The five §8.2 production axes, in canonical order. */
export const MFCI_AXES = ['user_group', 'topic', 'time_bucket', 'action_type', 'target'] as const;
export type MfciAxisName = (typeof MFCI_AXES)[number];

export interface SparseTable {
  axes: readonly AxisDef[];
  /** index-tuple key (joined with ',') → nonnegative integer count. */
  cells: Map<string, number>;
  total: number;
}

export function cellKey(indices: readonly number[]): string {
  return indices.join(',');
}

export function keyToIndices(key: string): number[] {
  if (key === '') return [];
  return key.split(',').map((s) => Number.parseInt(s, 10));
}

export interface ActionObservation {
  /** One label per axis, in `axes` order. */
  labels: readonly string[];
  count?: number | undefined;
}

/**
 * Build the sparse table from labeled observations. Unknown labels are an
 * input error (the axis label sets define the table's support).
 */
export function buildSparseTable(
  axes: readonly AxisDef[],
  observations: readonly ActionObservation[],
): SparseTable {
  const labelIndex: Array<Map<string, number>> = axes.map(
    (axis) => new Map(axis.labels.map((label, i) => [label, i])),
  );
  const cells = new Map<string, number>();
  let total = 0;
  for (const obs of observations) {
    if (obs.labels.length !== axes.length) {
      throw new Error(`observation has ${obs.labels.length} labels for ${axes.length} axes`);
    }
    const count = obs.count ?? 1;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`observation count must be a nonnegative integer (got ${count})`);
    }
    const indices = obs.labels.map((label, axis) => {
      const idx = labelIndex[axis]?.get(label);
      if (idx === undefined)
        throw new Error(`unknown label '${label}' on axis ${axes[axis]?.name}`);
      return idx;
    });
    const key = cellKey(indices);
    cells.set(key, (cells.get(key) ?? 0) + count);
    total += count;
  }
  return { axes, cells, total };
}

/** All 1-way margins: margins[axis][labelIndex] = Σ over the other axes. */
export function computeMargins(table: SparseTable): number[][] {
  const margins = table.axes.map((axis) => new Array<number>(axis.labels.length).fill(0));
  for (const [key, count] of table.cells) {
    const indices = keyToIndices(key);
    indices.forEach((labelIdx, axis) => {
      const axisMargins = margins[axis];
      if (axisMargins) axisMargins[labelIdx] = (axisMargins[labelIdx] ?? 0) + count;
    });
  }
  return margins;
}

/** Two tables share margins ⇔ they lie in the same fiber. */
export function sameMargins(a: SparseTable, b: SparseTable): boolean {
  const ma = computeMargins(a);
  const mb = computeMargins(b);
  if (ma.length !== mb.length) return false;
  return ma.every(
    (axis, i) => axis.length === (mb[i]?.length ?? -1) && axis.every((v, j) => v === mb[i]?.[j]),
  );
}

export function cloneTable(table: SparseTable): SparseTable {
  return { axes: table.axes, cells: new Map(table.cells), total: table.total };
}

/**
 * 2-way flattening: counts over a pair of axes, summing the rest. The MFCI
 * coordination statistics are quadratic functionals of these flattenings —
 * they vary across the fiber precisely because only 1-way margins are fixed.
 */
export function flatten2Way(table: SparseTable, axisA: number, axisB: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, count] of table.cells) {
    const indices = keyToIndices(key);
    const pairKey = `${indices[axisA]},${indices[axisB]}`;
    out.set(pairKey, (out.get(pairKey) ?? 0) + count);
  }
  return out;
}

/**
 * A reference to the margin structure persisted alongside outputs so every
 * automated decision can show which margins it conditioned on (MFCI-4).
 */
export function describeMargins(table: SparseTable): {
  axes: string[];
  margins: number[][];
  total: number;
} {
  return {
    axes: table.axes.map((a) => a.name),
    margins: computeMargins(table),
    total: table.total,
  };
}
