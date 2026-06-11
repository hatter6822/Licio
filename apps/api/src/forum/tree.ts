// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure tree + structured-section logic (WS-G.1.2d-1 / WS-G.3.3, SPEC §6.4).
// The six reading sections route contribution TYPES (the WS-G.3.3 table):
//
//   overview   ← synthesis (+ the layered summary, served separately)
//   questions  ← question (answers nest beneath their questions)
//   evidence   ← evidence, counterexample
//   challenges ← correction
//   lenses     ← local_context, direct_experience (+ lens-tagged)
//   chronology ← ALL types, flat time order
//
// Tree order is depth-first: roots by (created_at, id) ascending, children
// likewise — deterministic, so DFS-sequence pagination is stable.  `depth`
// indicators are ABSOLUTE tree depth (path length), preserved even when a
// section renders a mid-tree node as its local root.
import type { BranchId, ContributionType } from '@licio/shared';
import type { ContributionRecord } from './stores.js';

/** Types listed in each structured section (chronology = all). */
export const SECTION_TYPES: Readonly<
  Record<Exclude<BranchId, 'chronology'>, readonly ContributionType[]>
> = {
  overview: ['synthesis'],
  questions: ['question', 'answer'],
  evidence: ['evidence', 'counterexample'],
  challenges: ['correction'],
  lenses: ['local_context', 'direct_experience'],
};

/** The section a contribution type renders under (anchor resolution). */
export function sectionOfType(type: ContributionType): BranchId {
  switch (type) {
    case 'synthesis':
      return 'overview';
    case 'question':
    case 'answer':
      return 'questions';
    case 'evidence':
    case 'counterexample':
      return 'evidence';
    case 'correction':
      return 'challenges';
    case 'local_context':
    case 'direct_experience':
      return 'lenses';
    case 'explanation':
    case 'moderation_concern':
    case 'meta_discussion':
      return 'chronology';
  }
}

function byCreatedThenId(a: ContributionRecord, b: ContributionRecord): number {
  return a.createdAt === b.createdAt
    ? a.contributionId.localeCompare(b.contributionId)
    : a.createdAt.localeCompare(b.createdAt);
}

/**
 * Order a set of contributions depth-first (WS-G.3.3 "tree order with depth
 * indicators").  A node whose parent is OUTSIDE the given set renders as a
 * local root (its absolute depth indicator is preserved).  Total and
 * deterministic: cycles cannot occur (paths are append-only and parents are
 * immutable), and any malformed row degrades to a local root.
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

/**
 * Ancestor walk (contribution → root), root-first — straight off the
 * materialized path (WS-G.1.2d-1 helper).
 */
export function ancestorIds(row: ContributionRecord): readonly string[] {
  return row.path;
}

/** The subtree root of a contribution (itself when it is a root). */
export function subtreeRootId(row: ContributionRecord): string {
  return row.path[0] ?? row.contributionId;
}
