// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Counterfactual Invariance Defect (WS-H.7.5, SPEC §12.5).
//
//   CID(x, u) = E_g | R(g.x, g.u) − R(x, u) |
//
// The transformation group G acts on REPRESENTATIONS (attribute → value
// records), never raw data. Generators are value PERMUTATIONS of a single
// protected attribute (identity swaps, language translation, source swaps);
// `generateGroup` LIFTS them to `GroupElement`s and closes under composition +
// inversion ACROSS attributes (bounded BFS), so a multi-attribute generator set
// yields the FULL product group — including every cross-attribute composite gL∘gA
// (which swaps two attributes at once).  This is load-bearing: without the
// cross-attribute composites the returned set is not closed and CID is BLIND to
// INTERSECTIONAL bias (a ranking biased only against the intersection scores
// CID = 0 and passes the release gate).  CID = 0 means ranking is invariant to the
// transformations; a high CID on protected attributes is the bias signal the
// model-release gate consumes.

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

/**
 * A group element acting on representations across ONE OR MORE attributes.  A
 * single-attribute generator lifts to a one-key `mappings`; composition of two
 * different-attribute swaps produces a two-key element (e.g. gL∘gA swaps BOTH
 * locale AND age_band).  This is what makes `generateGroup` produce a genuine
 * CLOSED group for a multi-attribute generator set — without it the returned set
 * omits every cross-attribute composite, so CID is blind to intersectional bias.
 */
export interface GroupElement {
  id: string;
  /** attribute → its value permutation (values absent stay fixed). */
  mappings: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Lift a single-attribute permutation into a group element. */
export function liftPermutation(p: AttributePermutation): GroupElement {
  return { id: p.id, mappings: { [p.attribute]: p.mapping } };
}

/** Apply a group element to a representation (each attribute's permutation). */
export function applyGroupElement(
  element: GroupElement,
  representation: Representation,
): Representation {
  let result = representation;
  for (const [attribute, mapping] of Object.entries(element.mappings)) {
    const value = result[attribute];
    if (value === undefined) continue;
    const mapped = mapping[value];
    if (mapped === undefined) continue;
    result = { ...result, [attribute]: mapped };
  }
  return result;
}

/** Componentwise composition (a ∘ b)(v) = a(b(v)) over the union of attributes. */
export function composeGroupElements(a: GroupElement, b: GroupElement): GroupElement {
  const attributes = new Set([...Object.keys(a.mappings), ...Object.keys(b.mappings)]);
  const mappings: Record<string, Record<string, string>> = {};
  for (const attribute of attributes) {
    const am = a.mappings[attribute] ?? {};
    const bm = b.mappings[attribute] ?? {};
    const domain = new Set([...Object.keys(am), ...Object.keys(bm)]);
    const mapping: Record<string, string> = {};
    for (const value of domain) {
      const afterB = bm[value] ?? value;
      mapping[value] = am[afterB] ?? afterB;
    }
    mappings[attribute] = mapping;
  }
  return { id: `${a.id}∘${b.id}`, mappings };
}

/** Componentwise inverse. */
export function invertGroupElement(element: GroupElement): GroupElement {
  const mappings: Record<string, Record<string, string>> = {};
  for (const [attribute, mapping] of Object.entries(element.mappings)) {
    const inverse: Record<string, string> = {};
    for (const [from, to] of Object.entries(mapping)) inverse[to] = from;
    mappings[attribute] = inverse;
  }
  return { id: `${element.id}⁻¹`, mappings };
}

/**
 * A canonical key over the ELEMENT'S ACTION: the sorted, attribute-qualified set of
 * non-fixed value moves across ALL attributes (codepoint order, not localeCompare,
 * so it is deterministic across ICU versions).  Empty support ⇒ '' = THE identity,
 * so gA∘gA and any product of a swap with itself collapses onto the single identity
 * (no per-attribute duplicate-identity elements).  Attribute-qualifying each move
 * (`attr:from>to`) keeps two different attributes that share value literals distinct.
 */
function groupElementKey(element: GroupElement): string {
  const moves: string[] = [];
  for (const [attribute, mapping] of Object.entries(element.mappings)) {
    for (const [from, to] of Object.entries(mapping)) {
      if (from !== to) moves.push(`${attribute}:${from}>${to}`);
    }
  }
  moves.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return moves.join(',');
}

/**
 * Close a generator set into a genuine group: lift each single-attribute generator,
 * then close under composition + inversion across ALL attributes (bounded BFS), so a
 * multi-attribute generator set yields the full product group (incl. every
 * cross-attribute composite gL∘gA).  Bounded by `maxElements`; the identity is always
 * present exactly once.
 */
export function generateGroup(
  generators: readonly AttributePermutation[],
  maxElements = 64,
): GroupElement[] {
  for (const generator of generators) {
    const problem = validatePermutation(generator);
    if (problem) throw new Error(problem);
  }
  const identity: GroupElement = { id: IDENTITY_ID, mappings: {} };
  const elements = new Map<string, GroupElement>();
  elements.set(groupElementKey(identity), identity); // key '' — the single identity
  const queue: GroupElement[] = [];
  for (const generator of generators) {
    const lifted = liftPermutation(generator);
    for (const element of [lifted, invertGroupElement(lifted)]) {
      const key = groupElementKey(element);
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
      if (groupElementKey(other) === '') continue; // skip the identity
      const composed = composeGroupElements(current, other);
      const key = groupElementKey(composed);
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
  elements: readonly GroupElement[],
): CidResult {
  if (elements.length === 0) throw new Error('CID requires at least one group element');
  const baseline = ranking(content, user);
  if (!Number.isFinite(baseline)) throw new Error('ranking function returned a non-finite value');
  const perElement = elements.map((g) => {
    const transformed = ranking(applyGroupElement(g, content), applyGroupElement(g, user));
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
