// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hodge Conversation Tension — simplicial complex construction
// (WS-H.7.1a, SPEC §12.1).
//
// A conversation becomes a simplicial complex: vertices are participants
// and claims, oriented edges carry the NET interaction flow between two
// vertices (agreement positive, disagreement/correction negative, attention
// weakly positive — the kind weights are explicit configuration), and
// triangles are vertex triples whose three edges are all present
// (multi-party exchanges). Edges store a canonical orientation
// (lexicographic by vertex id) so flows from both directions accumulate
// consistently: an interaction v→u adds −w to the canonical u→v edge.

export const INTERACTION_KINDS = ['agreement', 'disagreement', 'correction', 'attention'] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export interface Interaction {
  from: string;
  to: string;
  kind: InteractionKind;
  /** Interaction strength (contribution-type weight from WS-G). */
  weight: number;
}

export interface InteractionKindWeights {
  agreement: number;
  disagreement: number;
  correction: number;
  attention: number;
}

/**
 * Default flow signs: agreement aligns flow toward the target, disagreement
 * and correction push against it, attention is a weak positive engagement.
 */
export const DEFAULT_KIND_WEIGHTS: InteractionKindWeights = {
  agreement: 1,
  disagreement: -1,
  correction: -0.5,
  attention: 0.25,
};

export interface OrientedEdge {
  /** Canonical orientation: from < to (lexicographic). */
  from: string;
  to: string;
  /** Net signed flow along the canonical orientation. */
  flow: number;
}

export interface ConversationComplex {
  vertices: string[];
  edges: OrientedEdge[];
  /** Triangles as vertex-id triples (sorted), referencing existing edges. */
  triangles: Array<[string, string, string]>;
}

/** Canonical (sorted) pair key. */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\x00${b}` : `${b}\x00${a}`;
}

/**
 * Codepoint comparator, NOT localeCompare: edge ordering must be deterministic
 * across runtimes/ICU versions (the same rule reeb/index.ts pins). ASCII ids
 * are unaffected; non-ASCII ids would otherwise be locale-dependent.
 */
const cp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build the complex from raw interactions. Triangle enumeration intersects
 * edge-neighborhoods (O(E · max-degree)) so a 500-participant conversation
 * stays within the batch budget.
 */
export function buildConversationComplex(
  interactions: readonly Interaction[],
  kindWeights: InteractionKindWeights = DEFAULT_KIND_WEIGHTS,
): ConversationComplex {
  const vertices = new Set<string>();
  const flows = new Map<string, number>();
  for (const interaction of interactions) {
    if (interaction.from === interaction.to) continue; // no self-loops in C1
    if (!Number.isFinite(interaction.weight) || interaction.weight < 0) {
      throw new Error('interaction weight must be a nonnegative finite number');
    }
    vertices.add(interaction.from);
    vertices.add(interaction.to);
    const canonical = interaction.from < interaction.to;
    const sign = canonical ? 1 : -1;
    const key = edgeKey(interaction.from, interaction.to);
    const value = kindWeights[interaction.kind] * interaction.weight * sign;
    flows.set(key, (flows.get(key) ?? 0) + value);
  }

  const edges: OrientedEdge[] = [...flows.entries()]
    .map(([key, flow]) => {
      const [from, to] = key.split('\x00');
      return { from: from ?? '', to: to ?? '', flow };
    })
    .sort((a, b) => cp(a.from, b.from) || cp(a.to, b.to));

  // Neighbor sets for triangle enumeration.
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges) {
    const fromSet = neighbors.get(edge.from) ?? new Set<string>();
    fromSet.add(edge.to);
    neighbors.set(edge.from, fromSet);
    const toSet = neighbors.get(edge.to) ?? new Set<string>();
    toSet.add(edge.from);
    neighbors.set(edge.to, toSet);
  }
  const triangles: Array<[string, string, string]> = [];
  for (const edge of edges) {
    const fromNeighbors = neighbors.get(edge.from);
    const toNeighbors = neighbors.get(edge.to);
    if (!fromNeighbors || !toNeighbors) continue;
    const smaller = fromNeighbors.size <= toNeighbors.size ? fromNeighbors : toNeighbors;
    const larger = smaller === fromNeighbors ? toNeighbors : fromNeighbors;
    for (const third of smaller) {
      if (third === edge.from || third === edge.to) continue;
      if (!larger.has(third)) continue;
      // Count each triangle once: only when `third` sorts after both ends.
      if (third > edge.to && edge.from < edge.to) {
        triangles.push([edge.from, edge.to, third]);
      }
    }
  }

  return { vertices: [...vertices].sort(), edges, triangles };
}
