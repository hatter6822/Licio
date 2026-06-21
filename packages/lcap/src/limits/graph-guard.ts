// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Malicious-dependency-graph guard (OFFLINE_SPEC §27.2, WS-R.14.2 — the PURE
// core).  `checkDependencyGraph` runs the §27.2 detectors over a received batch's
// DECLARED dependency DAG *before* any closure expansion or validation, so a
// hostile graph is rejected cheaply and cannot become a CPU/memory amplification
// vector.  The detectors:
//
//   - node-count cap (the whole-batch DoS bound — checked first so every later
//     pass is bounded);
//   - excessive fan-out (one object declaring too many direct prerequisites);
//   - duplicate dependencies (the same prerequisite listed twice — malformed);
//   - private metadata in a public export (a §27.2 privacy breach);
//   - unknown critical fields (a §11 forward-incompatible record);
//   - dependency cycles and excessive dependency depth (a single bounded DFS).
//
// Each detector maps to a §16.11 wire rejection code, so the result is usable
// directly as an object status.  A breach aborts the whole import (§27.2): the
// graph is untrusted, so no part of it is expanded.  PURE and I/O-free; the
// reader (WS-R.4.2) and the server parse (WS-R.12.1a) consume it.

import type { ObjectStatusCode } from '../pack/status.js';
import { SERVER_CAPS } from './caps.js';

/** A received object's declared dependency edges + the parse-layer content flags. */
export interface GraphGuardNode {
  readonly cid: string;
  /** The directly-declared prerequisite CIDs (may point outside the batch). */
  readonly requires: readonly string[];
  /** Set by the parse layer: the record carries private metadata (§27.2). */
  readonly hasPrivateMetadata?: boolean;
  /** Set by the parse layer: the record carries an unknown critical field (§11). */
  readonly hasUnknownCriticalField?: boolean;
}

/** The §27.1 graph caps (profile-tunable, never disable-able). */
export interface GraphGuardLimits {
  /** Max objects in one import batch. */
  readonly maxNodes: number;
  /** Max direct prerequisites a single object may declare. */
  readonly maxFanOut: number;
  /** Max in-batch dependency-chain depth. */
  readonly maxDepth: number;
}

// Sourced from the §27.1 caps SSOT (WS-R.14.1a) — never hard-coded here.
export const DEFAULT_GRAPH_LIMITS: GraphGuardLimits = Object.freeze({
  maxNodes: SERVER_CAPS.maxGraphNodes,
  maxFanOut: SERVER_CAPS.maxFanOut,
  maxDepth: SERVER_CAPS.maxDependencyDepth,
});

/** Project a {@link ResourceCaps} profile into the graph guard's limit view. */
export function graphLimitsFromCaps(caps: {
  readonly maxGraphNodes: number;
  readonly maxFanOut: number;
  readonly maxDependencyDepth: number;
}): GraphGuardLimits {
  return Object.freeze({
    maxNodes: caps.maxGraphNodes,
    maxFanOut: caps.maxFanOut,
    maxDepth: caps.maxDependencyDepth,
  });
}

/** The §16.11 rejection codes a graph breach can produce. */
export type GraphRejectionCode = Extract<
  ObjectStatusCode,
  'rejected_resource_limit' | 'rejected_bad_schema' | 'rejected_policy_denied'
>;

export interface GraphGuardOk {
  readonly ok: true;
}
export interface GraphGuardRejection {
  readonly ok: false;
  readonly code: GraphRejectionCode;
  /** The violated detector name (audit/debug; never a record value). */
  readonly detector: string;
  /** The offending object CID, when a single object is to blame. */
  readonly cid?: string;
}
export type GraphGuardResult = GraphGuardOk | GraphGuardRejection;

/** The export audience — the privacy detector only fires on a public export. */
export type ExportAudience = 'public' | 'restricted' | 'private';

export interface GraphGuardContext {
  readonly audience: ExportAudience;
  readonly limits?: GraphGuardLimits;
}

const reject = (code: GraphRejectionCode, detector: string, cid?: string): GraphGuardRejection =>
  cid === undefined ? { ok: false, code, detector } : { ok: false, code, detector, cid };

/**
 * Validate a declared dependency DAG against the §27.2 detectors.  Returns the
 * first breach (deterministic detector order) or `{ ok: true }`.  Bounded: the
 * node-count cap gates every subsequent pass, so the guard's own cost is linear in
 * the (capped) batch size.
 */
export function checkDependencyGraph(
  nodes: readonly GraphGuardNode[],
  ctx: GraphGuardContext,
): GraphGuardResult {
  const limits = ctx.limits ?? DEFAULT_GRAPH_LIMITS;

  // (1) Whole-batch node-count cap — first, so the passes below are bounded.
  if (nodes.length > limits.maxNodes) {
    return reject('rejected_resource_limit', 'node_count');
  }

  const byCid = new Map<string, GraphGuardNode>();
  for (const node of nodes) {
    if (!byCid.has(node.cid)) byCid.set(node.cid, node);
  }

  // (2) Per-node single pass: fan-out, duplicate deps, privacy, unknown fields.
  for (const node of byCid.values()) {
    if (node.requires.length > limits.maxFanOut) {
      return reject('rejected_resource_limit', 'fan_out', node.cid);
    }
    if (new Set(node.requires).size !== node.requires.length) {
      return reject('rejected_bad_schema', 'duplicate_dependency', node.cid);
    }
    if (ctx.audience === 'public' && node.hasPrivateMetadata === true) {
      return reject('rejected_policy_denied', 'private_in_public', node.cid);
    }
    if (node.hasUnknownCriticalField === true) {
      return reject('rejected_bad_schema', 'unknown_critical_field', node.cid);
    }
  }

  // (3) Cycle + depth in one bounded DFS over in-batch edges.
  const color = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const depthMemo = new Map<string, number>();
  const state = {
    cycleCid: undefined as string | undefined,
    tooDeepCid: undefined as string | undefined,
  };

  const visit = (cid: string, pathDepth: number): number => {
    const c = color.get(cid);
    if (c === 1) {
      state.cycleCid = cid;
      return 0;
    }
    if (c === 2) return depthMemo.get(cid) ?? 0;
    const node = byCid.get(cid);
    if (node === undefined) return 0; // external prerequisite — a leaf, not expanded
    // Stop BEFORE recursing past the depth cap: a long in-batch chain is rejected as
    // `depth` rather than followed deep enough to overflow the call stack (§27.2).  The
    // recursion is therefore bounded to maxDepth + 1 frames regardless of chain length.
    if (pathDepth > limits.maxDepth) {
      state.tooDeepCid = cid;
      return 0;
    }
    color.set(cid, 1);
    let maxChild = 0;
    for (const req of node.requires) {
      const d = visit(req, pathDepth + 1);
      if (state.cycleCid !== undefined || state.tooDeepCid !== undefined) return 0;
      if (d > maxChild) maxChild = d;
    }
    color.set(cid, 2);
    const depth = node.requires.length === 0 ? 0 : maxChild + 1;
    depthMemo.set(cid, depth);
    return depth;
  };

  for (const node of byCid.values()) {
    if (color.get(node.cid) === 2) continue;
    const depth = visit(node.cid, 0);
    if (state.cycleCid !== undefined) {
      return reject('rejected_bad_schema', 'cycle', state.cycleCid);
    }
    if (state.tooDeepCid !== undefined) {
      return reject('rejected_resource_limit', 'depth', state.tooDeepCid);
    }
    if (depth > limits.maxDepth) {
      return reject('rejected_resource_limit', 'depth', node.cid);
    }
  }

  return { ok: true };
}
