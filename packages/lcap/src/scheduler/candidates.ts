// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Candidate assembly, policy filtering, and dependency-closure promotion
// (OFFLINE_SPEC §15.4 steps 1-3, §17.5, WS-R.5.2a).  From the seeds (explicit
// wants, room interests, the outbox, known missing deps): remove
// privacy/budget/capability-forbidden objects BEFORE closure promotion, then for
// each surviving renderable object pull in its minimal trust/render closure and
// record the `requires` edges.  The result is closure-complete (no candidate has
// an unsatisfied `requires` edge) and a pure function of its inputs.

import type { ScheduledCandidate } from './types.js';

export interface CandidateAssemblyInput {
  /** Every locally-available object, keyed by CID. */
  readonly objects: ReadonlyMap<string, Omit<ScheduledCandidate, 'requires'>>;
  /** Renderable roots from wants / interests / outbox / missing deps. */
  readonly seeds: readonly string[];
  /** Forbidden by privacy policy, the storage/transfer budget, or capability. */
  readonly forbidden: (cid: string) => boolean;
  /** The minimal trust/render closure (cert/cap/proof/body/parent/checkpoint). */
  readonly requiresOf: (cid: string) => readonly string[];
}

/**
 * Assemble the closure-complete candidate set.  Forbidden seeds are removed
 * before any closure is promoted (their closures are not pulled in gratuitously);
 * each included object's `requires` edges all point to included candidates.
 */
export function assembleCandidates(input: CandidateAssemblyInput): ScheduledCandidate[] {
  const included = new Map<string, ScheduledCandidate>();
  // Deterministic worklist order (sorted seeds), so the output is reproducible.
  const queue = [...input.seeds].sort();
  while (queue.length > 0) {
    const cid = queue.shift() as string;
    if (included.has(cid) || input.forbidden(cid)) continue;
    const object = input.objects.get(cid);
    if (!object) continue; // cannot ship an object we do not have
    // Closure deps that are available and not forbidden (trust material).
    const requires = input
      .requiresOf(cid)
      .filter((dep) => input.objects.has(dep) && !input.forbidden(dep));
    included.set(cid, { ...object, requires });
    for (const dep of requires) if (!included.has(dep)) queue.push(dep);
  }
  // Stable order by (priority, cid) for downstream determinism.
  return [...included.values()].sort(
    (a, b) => a.priority - b.priority || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0),
  );
}

/** True iff every `requires` edge of every candidate points to an included CID. */
export function isClosureComplete(candidates: readonly ScheduledCandidate[]): boolean {
  const present = new Set(candidates.map((c) => c.cid));
  return candidates.every((c) => c.requires.every((dep) => present.has(dep)));
}
