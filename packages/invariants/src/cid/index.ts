// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Counterfactual Invariance Defect (WS-H.7.5, SPEC §12.5).
//
//   CID(x, u) = E_g | R(g.x, g.u) − R(x, u) |
//
// The transformation group G acts on REPRESENTATIONS (attribute → value
// records), never raw data. Transformations are value PERMUTATIONS of a
// single protected attribute (identity swaps, language translation, source
// swaps): permutations compose, invert, and contain the identity, so the
// generated set is a genuine group — `generateGroup` closes the generators
// under composition (bounded BFS) and the group axioms hold by
// construction (verified by tests via `composeTransformations` /
// `invertTransformation`). CID = 0 means ranking is invariant to the
// transformations; a high CID on protected attributes is the bias signal
// the model-release gate consumes.

export interface AttributePermutation {
  /** Stable id, e.g. `gender:swap-a-b`, `language:en->es`. */
  id: string;
  attribute: string;
  /** Bijective value mapping (validated). Values absent stay fixed. */
  mapping: Readonly<Record<string, string>>;
}

export type Representation = Readonly<Record<string, string>>;

/** Validate bijectivity: a permutation must map distinct values distinctly. */
export function validatePermutation(p: AttributePermutation): string | null {
  const targets = Object.values(p.mapping);
  if (new Set(targets).size !== targets.length) {
    return `mapping for '${p.attribute}' is not injective`;
  }
  // Closure on its own domain keeps repeated application well-defined.
  for (const target of targets) {
    if (!(target in p.mapping)) {
      return `mapping for '${p.attribute}' is not closed over its domain (missing '${target}')`;
    }
  }
  return null;
}

/** Apply a permutation to a representation (non-destructive). */
export function applyTransformation(
  p: AttributePermutation,
  representation: Representation,
): Representation {
  const value = representation[p.attribute];
  if (value === undefined) return representation;
  const mapped = p.mapping[value];
  if (mapped === undefined) return representation;
  return { ...representation, [p.attribute]: mapped };
}

/** Compose two same-attribute permutations: (a ∘ b)(v) = a(b(v)). */
export function composeTransformations(
  a: AttributePermutation,
  b: AttributePermutation,
): AttributePermutation {
  if (a.attribute !== b.attribute) {
    throw new Error('composition requires permutations of the same attribute');
  }
  const domain = new Set([...Object.keys(a.mapping), ...Object.keys(b.mapping)]);
  const mapping: Record<string, string> = {};
  for (const value of domain) {
    const afterB = b.mapping[value] ?? value;
    mapping[value] = a.mapping[afterB] ?? afterB;
  }
  return { id: `${a.id}∘${b.id}`, attribute: a.attribute, mapping };
}

/** Exact inverse permutation. */
export function invertTransformation(p: AttributePermutation): AttributePermutation {
  const mapping: Record<string, string> = {};
  for (const [from, to] of Object.entries(p.mapping)) mapping[to] = from;
  return { id: `${p.id}⁻¹`, attribute: p.attribute, mapping };
}

const IDENTITY_ID = 'identity';

function canonicalKey(p: AttributePermutation): string {
  const entries = Object.entries(p.mapping)
    .filter(([from, to]) => from !== to)
    // Codepoint order, NOT localeCompare: a "canonical" key must be deterministic
    // across runtimes/ICU versions, never locale-dependent.
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([from, to]) => `${from}>${to}`)
    .join(',');
  return `${p.attribute}|${entries}`;
}

/**
 * Close a generator set under composition and inversion (per attribute),
 * bounded by `maxElements`. The identity element is always included.
 */
export function generateGroup(
  generators: readonly AttributePermutation[],
  maxElements = 64,
): AttributePermutation[] {
  for (const generator of generators) {
    const problem = validatePermutation(generator);
    if (problem) throw new Error(problem);
  }
  const identityElement: AttributePermutation = {
    id: IDENTITY_ID,
    attribute: generators[0]?.attribute ?? '',
    mapping: {},
  };
  const elements = new Map<string, AttributePermutation>();
  elements.set(canonicalKey(identityElement), identityElement);
  const queue: AttributePermutation[] = [];
  for (const generator of generators) {
    for (const element of [generator, invertTransformation(generator)]) {
      const key = canonicalKey(element);
      if (!elements.has(key)) {
        elements.set(key, element);
        queue.push(element);
      }
    }
  }
  while (queue.length > 0 && elements.size < maxElements) {
    const current = queue.shift();
    if (!current) break;
    for (const other of [...elements.values()]) {
      if (other.attribute !== current.attribute || other.id === IDENTITY_ID) continue;
      const composed = composeTransformations(current, other);
      const key = canonicalKey(composed);
      if (!elements.has(key) && elements.size < maxElements) {
        elements.set(key, composed);
        queue.push(composed);
      }
    }
  }
  return [...elements.values()];
}

export type RankingFunction = (content: Representation, user: Representation) => number;

export interface CidResult {
  cid: number;
  /** Per-element |R(g.x, g.u) − R(x, u)| for audit logs. */
  perElement: Array<{ id: string; deviation: number }>;
  elementCount: number;
}

/** CID(x, u) over a group element list (mean absolute ranking deviation). */
export function counterfactualInvarianceDefect(
  ranking: RankingFunction,
  content: Representation,
  user: Representation,
  elements: readonly AttributePermutation[],
): CidResult {
  if (elements.length === 0) throw new Error('CID requires at least one group element');
  const baseline = ranking(content, user);
  if (!Number.isFinite(baseline)) throw new Error('ranking function returned a non-finite value');
  const perElement = elements.map((g) => {
    const transformed = ranking(applyTransformation(g, content), applyTransformation(g, user));
    if (!Number.isFinite(transformed)) {
      throw new Error(`ranking function returned a non-finite value under ${g.id}`);
    }
    return { id: g.id, deviation: Math.abs(transformed - baseline) };
  });
  const cid = perElement.reduce((acc, e) => acc + e.deviation, 0) / perElement.length;
  return { cid, perElement, elementCount: elements.length };
}

export interface CidGateDecision {
  blocked: boolean;
  cid: number;
  threshold: number;
}

/** Model-release gate (WS-H.7.5b): CID above threshold blocks the launch. */
export function cidReleaseGate(cid: number, threshold: number): CidGateDecision {
  if (!(threshold > 0)) throw new Error('CID gate threshold must be positive');
  // Fail CLOSED on a non-finite CID: a NaN would make `cid > threshold` false
  // and silently let a launch through this SAFETY gate. An unmeasurable
  // counterfactual-invariance defect must block, never pass.
  if (!Number.isFinite(cid)) return { blocked: true, cid, threshold };
  return { blocked: cid > threshold, cid, threshold };
}

export const CID_VERSION = '1.0.0';
