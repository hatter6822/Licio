// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ingestion stage-2 dependency resolution (OFFLINE_SPEC §24.1 "resolve", §24.4
// processing order, WS-R.12.1b — the PURE core).  Given a batch of received
// objects (each declaring its prerequisite CIDs and its §24.4 processing class)
// and a predicate for what the receiver already holds validated,
// `resolveIngestionOrder` returns:
//
//   - `order`: the prerequisites-before-dependents validation order, with §24.4
//     class priority (certs → capabilities → revocations → checkpoints →
//     moderation policy → records) breaking ties among simultaneously-ready
//     objects — so a child is never validated before a required parent/cert/cap,
//     and moderation policy is processed before the content it governs;
//   - `quarantined`: objects with ≥1 transitively-absent prerequisite (neither
//     held nor present in the batch) → the precise `missing_cids` to fetch (the
//     §24.1 wants);
//   - `cyclic`: objects unorderable purely because of a declared-dependency cycle
//     (malformed → `rejected_bad_schema`).
//
// PURE and I/O-free: the caller runs the shared `validate(record)` (WS-R.8.2c)
// over `order` and commits each via `ingestRecord` (WS-R.12.1c).  No canonical
// emission happens here — this stage only plans the order and the verdicts that
// follow from dependency availability.

/** The §24.4 processing classes, in priority order (lowest rank processed first). */
export type IngestionClass =
  | 'cert'
  | 'capability'
  | 'revocation'
  | 'checkpoint'
  | 'moderation'
  | 'record';

const CLASS_RANK: Record<IngestionClass, number> = {
  cert: 0,
  capability: 1,
  revocation: 2,
  checkpoint: 3,
  moderation: 4,
  record: 5,
};

/** A received object awaiting validation, with its declared prerequisites. */
export interface IngestionNode {
  readonly cid: string;
  readonly cls: IngestionClass;
  /** Prerequisite CIDs that MUST be validated/held before this object (§24.4). */
  readonly requires: readonly string[];
}

/** The resolved §24.1 stage-2 plan (pure; no canonical emission). */
export interface IngestionResolution {
  /** Prerequisites-before-dependents order with §24.4 class-priority tie-breaks. */
  readonly order: readonly string[];
  /** cid → its transitively-absent prerequisite CIDs (the §24.1 wants), ≥1 each. */
  readonly quarantined: ReadonlyMap<string, readonly string[]>;
  /** cids unorderable due to a declared-dependency cycle (→ rejected_bad_schema). */
  readonly cyclic: readonly string[];
}

/**
 * Resolve the §24.4 ingestion order + dependency verdicts for a received batch.
 * Deterministic for a given batch + `isHeld`.
 */
export function resolveIngestionOrder(
  batch: readonly IngestionNode[],
  isHeld: (cid: string) => boolean,
): IngestionResolution {
  // De-duplicate by cid (first occurrence wins); the batch index gives stable ties.
  const byCid = new Map<string, IngestionNode>();
  const index = new Map<string, number>();
  for (const node of batch) {
    if (!byCid.has(node.cid)) {
      index.set(node.cid, byCid.size);
      byCid.set(node.cid, node);
    }
  }

  const orderedSet = new Set<string>();
  const order: string[] = [];
  const satisfied = (cid: string): boolean => isHeld(cid) || orderedSet.has(cid);

  // Kahn-style rounds: each round emits every node whose prerequisites are all
  // satisfied (held or already ordered), choosing among the ready set by §24.4
  // class rank then stable batch index.  A prerequisite neither in the batch nor
  // held can never become satisfied — those nodes stay stuck for the partition
  // below.
  for (;;) {
    const ready: IngestionNode[] = [];
    for (const node of byCid.values()) {
      if (orderedSet.has(node.cid)) continue;
      if (node.requires.every(satisfied)) ready.push(node);
    }
    if (ready.length === 0) break;
    ready.sort((a, b) => {
      const byRank = CLASS_RANK[a.cls] - CLASS_RANK[b.cls];
      return byRank !== 0 ? byRank : (index.get(a.cid) ?? 0) - (index.get(b.cid) ?? 0);
    });
    for (const node of ready) {
      orderedSet.add(node.cid);
      order.push(node.cid);
    }
  }

  // Partition the stuck nodes: ≥1 transitively-absent prerequisite ⇒ quarantined
  // (the absent roots are the wants); stuck purely by a cycle (every transitive
  // prerequisite held or in-batch, yet unorderable) ⇒ cyclic.
  const quarantined = new Map<string, readonly string[]>();
  const cyclic: string[] = [];
  for (const node of byCid.values()) {
    if (orderedSet.has(node.cid)) continue;
    const absent = collectAbsent(node.cid, byCid, satisfied);
    if (absent.length > 0) quarantined.set(node.cid, absent);
    else cyclic.push(node.cid);
  }

  return { order, quarantined, cyclic };
}

/**
 * The transitively-absent prerequisite CIDs of a stuck node: a BFS over
 * prerequisites that descends into stuck in-batch prerequisites and collects any
 * CID that is neither satisfied nor present in the batch.  Satisfied branches
 * terminate; the visited guard makes cycles terminate without contributing a
 * (non-existent) absent root.  First-seen (breadth-first) order — deterministic.
 */
function collectAbsent(
  startCid: string,
  byCid: ReadonlyMap<string, IngestionNode>,
  satisfied: (cid: string) => boolean,
): string[] {
  const absent: string[] = [];
  const absentSeen = new Set<string>();
  const visited = new Set<string>([startCid]);
  const queue: string[] = [startCid];
  let head = 0;
  while (head < queue.length) {
    const cid = queue[head++];
    if (cid === undefined) break;
    const node = byCid.get(cid);
    if (node === undefined) continue;
    for (const req of node.requires) {
      if (satisfied(req)) continue; // branch already satisfied
      if (!byCid.has(req)) {
        if (!absentSeen.has(req)) {
          absentSeen.add(req);
          absent.push(req);
        }
        continue;
      }
      if (!visited.has(req)) {
        visited.add(req);
        queue.push(req);
      }
    }
  }
  return absent;
}
