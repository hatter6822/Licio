// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dependency-closure assembly (OFFLINE_SPEC §17.5, WS-R.7.2).  `minimalClosure`
// is a PURE function returning the minimal trust/render closure for a renderable
// contribution: device certificate + authority proof, room capability + authority
// proof, the contribution + its device proof, the body text block, and the latest
// known room-checkpoint summary — enough to reach `authorized_provisional` (or
// better) WITHOUT media.  Large media and old ancestor context are excluded by
// default and pulled only on explicit want (§17.5).  The lane scheduler
// (WS-R.5.2a) CONSUMES this via `requiresOfFromGraph`; the closure itself never
// depends on the scheduler.

/** The typed trust/render references an object contributes to a closure (§17.5). */
export interface ClosureRefs {
  /** The device certificate that authenticates the contribution's author device. */
  readonly deviceCertificateCid?: string;
  /** The room capability that authorizes the operation. */
  readonly capabilityCid?: string;
  /** Detached proofs (the contribution's device proof + cert/cap authority proofs). */
  readonly proofCids?: readonly string[];
  /** The body text block — render-essential, always included. */
  readonly bodyBlockCid?: string;
  /** Large media blocks — excluded by default (§17.5). */
  readonly mediaBlockCids?: readonly string[];
  /** The immediate parent contribution (context; excluded by default). */
  readonly parentCid?: string;
  /** The thread root contribution (context; excluded by default). */
  readonly rootCid?: string;
  /** The latest known room-checkpoint summary (tiny; included by default). */
  readonly checkpointSummaryCid?: string;
}

/** Transfer-shaping options for a closure (§17.5 defaults: no media, no ancestors). */
export interface ClosureOptions {
  /** Include large media blocks (default false). */
  readonly includeMedia?: boolean;
  /** Include parent/root context records (default false — old ancestors omitted). */
  readonly includeContext?: boolean;
  /** Include the latest room-checkpoint summary (default true; it is tiny). */
  readonly includeCheckpointSummary?: boolean;
}

/** A read-only view of the local object graph: the closure refs of any CID. */
export interface ClosureGraph {
  readonly refsOf: (cid: string) => ClosureRefs | undefined;
}

/**
 * The direct minimal-closure edges of a single object given the transfer options.
 * Order is deterministic and trust-first (cert, capability, proofs, body,
 * checkpoint, then — only if requested — context and media), de-duplicated.
 */
export function minimalClosureEdges(refs: ClosureRefs, options: ClosureOptions = {}): string[] {
  const edges: string[] = [];
  if (refs.deviceCertificateCid !== undefined) edges.push(refs.deviceCertificateCid);
  if (refs.capabilityCid !== undefined) edges.push(refs.capabilityCid);
  if (refs.proofCids !== undefined) edges.push(...refs.proofCids);
  if (refs.bodyBlockCid !== undefined) edges.push(refs.bodyBlockCid);
  if (options.includeCheckpointSummary !== false && refs.checkpointSummaryCid !== undefined) {
    edges.push(refs.checkpointSummaryCid);
  }
  if (options.includeContext === true) {
    if (refs.parentCid !== undefined) edges.push(refs.parentCid);
    if (refs.rootCid !== undefined) edges.push(refs.rootCid);
  }
  if (options.includeMedia === true && refs.mediaBlockCids !== undefined) {
    edges.push(...refs.mediaBlockCids);
  }
  // De-duplicate while preserving the trust-first insertion order.
  return [...new Set(edges)];
}

/**
 * The transitive minimal trust/render closure of a target (BFS over edges),
 * including the target itself.  Cycle-safe (a `seen` set guards re-entry) and a
 * pure function of `(targetCid, graph, options)`.
 */
export function minimalClosure(
  targetCid: string,
  graph: ClosureGraph,
  options: ClosureOptions = {},
): string[] {
  const seen = new Set<string>();
  const queue: string[] = [targetCid];
  while (queue.length > 0) {
    const cid = queue.shift() as string;
    if (seen.has(cid)) continue;
    seen.add(cid);
    const refs = graph.refsOf(cid);
    if (refs === undefined) continue; // an object we cannot resolve has no known edges
    for (const dep of minimalClosureEdges(refs, options)) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen];
}

/**
 * A `requiresOf` (WS-R.5.2a `assembleCandidates`) derived from the graph's
 * minimal-closure edges, so the allocator keeps every dependency ahead of its
 * dependents using exactly the §17.5 closure.
 */
export function requiresOfFromGraph(
  graph: ClosureGraph,
  options: ClosureOptions = {},
): (cid: string) => string[] {
  return (cid) => {
    const refs = graph.refsOf(cid);
    return refs === undefined ? [] : minimalClosureEdges(refs, options);
  };
}
