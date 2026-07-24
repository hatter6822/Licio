// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure materialized-path tree helpers. WS-T retires the six structured read
// sections; the remaining helpers preserve deterministic subtree ordering and
// semantic anchor root resolution.
import type { ContributionRecord } from './stores.js';

function byCreatedThenId(a: ContributionRecord, b: ContributionRecord): number {
  return a.createdAt === b.createdAt
    ? a.contributionId.localeCompare(b.contributionId)
    : a.createdAt.localeCompare(b.createdAt);
}

/**
 * Order a set of contributions depth-first. A node whose parent is outside the
 * given set renders as a local root; absolute depth remains on the row.
 */
export function orderDepthFirst(rows: readonly ContributionRecord[]): ContributionRecord[] {
  const present = new Set(rows.map((row) => row.contributionId));
  const children = new Map<string, ContributionRecord[]>();
  const roots: ContributionRecord[] = [];
  for (const row of rows) {
    const parent = row.parentContributionId;
    if (parent !== null && present.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(row);
      children.set(parent, list);
    } else {
      roots.push(row);
    }
  }
  roots.sort(byCreatedThenId);
  for (const list of children.values()) list.sort(byCreatedThenId);

  const ordered: ContributionRecord[] = [];
  const stack: ContributionRecord[] = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    ordered.push(node);
    const kids = children.get(node.contributionId) ?? [];
    for (let index = kids.length - 1; index >= 0; index -= 1) {
      const kid = kids[index];
      if (kid) stack.push(kid);
    }
  }
  return ordered;
}

export function subtreeRootId(row: ContributionRecord): string {
  return row.path[0] ?? row.contributionId;
}
