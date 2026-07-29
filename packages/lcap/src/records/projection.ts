// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic thread projection + display ordering (OFFLINE_SPEC §12.3, §12.4,
// §25.2, WS-R.2.2/2.3).  Edits, tombstones, and moderation actions are NEW
// records referencing earlier ones; record bodies are never mutated.  The
// visible thread is a deterministic projection over the append-only graph:
//   - an `edit` (`replaces_record_cid`) supersedes its target; the full edit
//     chain is retained, and a deterministic tip is chosen on conflict;
//   - a `tombstone` / `moderation_action` (`target_record_cid`) hides the whole
//     logical contribution (the stricter visible state wins, §25.1);
//   - an `edit` / `tombstone` is honoured ONLY over its own author's record;
//     acting on another member's contribution is the `moderate` operation, i.e.
//     a `moderation_action`.  A refused relation is retained and surfaced
//     (`unauthorizedSupersedes`), never silently dropped (§25.2);
//   - ordering follows the §12.4 precedence ladder, never trusting phone clocks
//     for canonical order.
// The projection output is independent of record arrival order.

import type { ContributionEventRecordV2 } from '../schemas/records.js';

/** A record in a thread, with the ordering hints the §12.4 ladder consults. */
export interface ThreadRecord {
  readonly recordCid: string;
  readonly record: ContributionEventRecordV2;
  /** Canonical server/room-log sequence, when known (§12.4 #1). */
  readonly roomLogSeq?: number;
  /** Checkpoint inclusion order, when known (§12.4 #4). */
  readonly checkpointIndex?: number;
  /** Local receipt/import time — the last-resort hint (§12.4 #6). */
  readonly receiptMs?: number;
}

const CONTENT_TYPES: ReadonlySet<ContributionEventRecordV2['event_type']> = new Set([
  'post',
  'question',
  'answer',
  'evidence',
  'correction',
  'synthesis',
  'counterexample',
  'clarification',
  'source_snapshot_ref',
]);

/**
 * Compare two records by the §12.4 precedence ladder: room-log sequence →
 * checkpoint index → claimed timestamp (a weak hint) → receipt time → `record_cid`
 * (a final deterministic tiebreak).  This is a PURE lexicographic TOTAL order —
 * every rung is unconditional, so it is transitive.  Per-device sequence is NOT a
 * rung here: it was a CONDITIONAL rung (fires only for same-device pairs), which
 * made the comparator non-transitive (A<B by device-seq, B<C and C<A by claim = a
 * 3-cycle) and left `Array.sort` output arrival-order-dependent, breaking the §25.2
 * determinism guarantee.  Device ordering is now a synthetic DAG edge in
 * `displayOrder`'s topological pass (via `prev_device_record_cid`), where causal
 * order already lives.  Phone clocks (claimed timestamp) only break ties nothing
 * else resolves.
 */
export function compareDisplayOrder(a: ThreadRecord, b: ThreadRecord): number {
  const byRoomLog = compareOptionalAsc(a.roomLogSeq, b.roomLogSeq);
  if (byRoomLog !== 0) return byRoomLog;

  const byCheckpoint = compareOptionalAsc(a.checkpointIndex, b.checkpointIndex);
  if (byCheckpoint !== 0) return byCheckpoint;

  const byClaim = compareOptionalAsc(a.record.created_at_claim_ms, b.record.created_at_claim_ms);
  if (byClaim !== 0) return byClaim;

  const byReceipt = compareOptionalAsc(a.receiptMs, b.receiptMs);
  if (byReceipt !== 0) return byReceipt;

  if (a.recordCid < b.recordCid) return -1;
  if (a.recordCid > b.recordCid) return 1;
  return 0;
}

/**
 * Compare two optional numbers ascending: the numeric compare when both are
 * present, else present-before-absent.  This MUST remain a TOTAL order (a
 * missing value maps to one consistent position) — treating a one-sided value
 * as a tie and deferring to a later rung would make the comparator
 * non-transitive (A>B and B>C by CID while A<C by value) and break
 * `displayOrder`'s deterministic, input-order-independent guarantee.  A weak
 * hint present on one side thus still breaks the tie; the final `record_cid`
 * rung is the ultimate deterministic tiebreak below it.
 */
function compareOptionalAsc(a: number | undefined, b: number | undefined): number {
  if (a !== undefined && b !== undefined) return a - b;
  if (a !== undefined) return -1;
  if (b !== undefined) return 1;
  return 0;
}

/**
 * Order records for display using the §12.4 precedence ladder with causal order
 * respected: a topological sort over `parent_record_cids` AND the per-device chain
 * (`prev_device_record_cid`) edges present in the set (predecessors before
 * successors), with `compareDisplayOrder` (a pure total order) ordering the ready
 * set.  Threading the device chain here — rather than as a conditional comparator
 * rung — keeps per-device sequence causal while the comparator stays transitive.
 * Total and deterministic; independent of input order.
 */
export function displayOrder(records: readonly ThreadRecord[]): ThreadRecord[] {
  const byCid = new Map(records.map((r) => [r.recordCid, r]));
  const inDegree = new Map<string, number>();
  const childrenOf = new Map<string, string[]>();
  for (const r of records) inDegree.set(r.recordCid, 0);
  for (const r of records) {
    // Content-DAG parents PLUS the same-device predecessor (§12.2), deduped so a
    // prev_device_record_cid that is also a content parent is not counted twice.
    const parents = new Set(r.record.parent_record_cids ?? []);
    if (r.record.prev_device_record_cid !== undefined) {
      // Honor prev_device_record_cid as a causal ordering edge ONLY when it is a
      // VERIFIED same-device immediate predecessor: the SAME device key AND
      // device_seq - 1. `prev_device_record_cid` is an author-supplied optional CID;
      // unverified, an author could point it at an arbitrary record to force its own
      // content after that record in every projection. When it fails the check it is
      // a non-authoritative hint and the §12.4 ladder orders the record instead.
      const prev = byCid.get(r.record.prev_device_record_cid);
      if (
        prev !== undefined &&
        prev.record.author_device_key_id === r.record.author_device_key_id &&
        prev.record.device_seq === r.record.device_seq - 1
      ) {
        parents.add(r.record.prev_device_record_cid);
      }
    }
    for (const parent of parents) {
      if (!byCid.has(parent)) continue;
      inDegree.set(r.recordCid, (inDegree.get(r.recordCid) ?? 0) + 1);
      const list = childrenOf.get(parent) ?? [];
      list.push(r.recordCid);
      childrenOf.set(parent, list);
    }
  }

  const ready = records.filter((r) => (inDegree.get(r.recordCid) ?? 0) === 0);
  const result: ThreadRecord[] = [];
  const placed = new Set<string>();
  while (ready.length > 0) {
    ready.sort(compareDisplayOrder);
    const next = ready.shift();
    if (!next) break;
    result.push(next);
    placed.add(next.recordCid);
    for (const childCid of childrenOf.get(next.recordCid) ?? []) {
      const remaining = (inDegree.get(childCid) ?? 1) - 1;
      inDegree.set(childCid, remaining);
      if (remaining === 0) {
        const child = byCid.get(childCid);
        if (child) ready.push(child);
      }
    }
  }
  // Any records left (a parent cycle — impossible in a CID DAG) append in a
  // deterministic order so projection stays total even on malformed input.
  if (placed.size < records.length) {
    const leftover = records.filter((r) => !placed.has(r.recordCid)).sort(compareDisplayOrder);
    result.push(...leftover);
  }
  return result;
}

/** A logical contribution after edit/tombstone resolution. */
export interface ProjectedContribution {
  /** The original (root) record's CID — the logical contribution's identity. */
  readonly rootCid: string;
  /** The CID of the latest visible version (the edit-chain tip). */
  readonly visibleCid: string;
  /** The latest visible version's record. */
  readonly record: ContributionEventRecordV2;
  /** Every CID from root to tip (the full retained edit chain). */
  readonly editChain: readonly string[];
  /** True if the contribution is tombstoned/moderated out. */
  readonly hidden: boolean;
  /** The CID of the tombstone/moderation record, when hidden. */
  readonly hiddenBy?: string;
  /**
   * CIDs of `edit` / `tombstone` records that named a record in this chain but
   * were authored by someone ELSE — refused (they never move the tip or hide the
   * contribution) yet RETAINED here, because §25.2 forbids silently discarding
   * conflicting evidence.  Sorted, so the projection stays arrival-order
   * independent.
   */
  readonly unauthorizedSupersedes?: readonly string[];
}

/**
 * Deterministically pick the visible edit among conflicting edits of one target:
 * the canonically-latest under the §12.4 precedence ladder (room-log seq →
 * checkpoint index → claim → receipt → record_cid), i.e. the maximum of the total
 * order `compareDisplayOrder`.  Per-device sequence is NOT a rung — it is only
 * meaningful within a single device's chain, so comparing `device_seq` across two
 * different authors could surface a stale edit whose author merely used a higher
 * local counter.  Because `compareDisplayOrder` is total, transitive, and
 * deterministic, taking its maximum is arrival-order-independent.
 */
function pickLatestEdit(edits: readonly ThreadRecord[]): ThreadRecord {
  let best = edits[0] as ThreadRecord;
  for (const edit of edits) {
    if (compareDisplayOrder(edit, best) > 0) best = edit;
  }
  return best;
}

/**
 * Project a thread's records into the visible logical contributions, in display
 * order.  Deterministic and arrival-order-independent: edit chains and
 * tombstones are resolved over the whole record set before ordering.
 */
export function reduceThreadProjection(records: readonly ThreadRecord[]): ProjectedContribution[] {
  const byCid = new Map(records.map((r) => [r.recordCid, r]));
  const editsByTarget = new Map<string, ThreadRecord[]>();
  const tombstoneByTarget = new Map<string, string>();
  /** Refused cross-author (or unresolvable) supersessions, keyed by the target they named. */
  const refusedByTarget = new Map<string, string[]>();
  const roots: ThreadRecord[] = [];

  /**
   * May `r` supersede/hide `targetCid`?  Only when it authored the target.
   * `replaces_record_cid` / `target_record_cid` are author-supplied CIDs and NOTHING
   * upstream binds them to the actor: `capabilityAuthorizes` checks that the
   * capability's subject is the record's OWN author and has no notion of the target's
   * author, and neither `validateIdentityChain` nor `validate()` reads
   * `replaces_record_cid` at all.  So without this check a signed, fully-`authorized`
   * `edit` by member B over member A's post is indistinguishable from A's own edit and
   * takes the visible tip — content replacement in the deterministic projection.
   * Acting on ANOTHER member's contribution is the distinct `moderate` operation, i.e.
   * a `moderation_action` record, which stays ungated below.
   *
   * Compare `author_account_id`, NOT `author_device_key_id`: a member legitimately
   * edits from a second device.  A target absent from this record set leaves the
   * relation unresolvable, so it cannot be honoured either.
   */
  const ownsTarget = (r: ThreadRecord, targetCid: string): boolean => {
    const target = byCid.get(targetCid);
    if (target !== undefined && target.record.author_account_id === r.record.author_account_id) {
      return true;
    }
    // Retain the refused record instead of dropping it (§25.2: conflicting evidence
    // stays inspectable); it is surfaced on the projection it tried to act on.
    const refused = refusedByTarget.get(targetCid) ?? [];
    refused.push(r.recordCid);
    refusedByTarget.set(targetCid, refused);
    return false;
  };

  for (const r of records) {
    const eventType = r.record.event_type;
    if (eventType === 'edit' && r.record.replaces_record_cid) {
      if (!ownsTarget(r, r.record.replaces_record_cid)) continue;
      const list = editsByTarget.get(r.record.replaces_record_cid) ?? [];
      list.push(r);
      editsByTarget.set(r.record.replaces_record_cid, list);
    } else if (
      (eventType === 'tombstone' || eventType === 'moderation_action') &&
      r.record.target_record_cid
    ) {
      // `moderation_action` is the SANCTIONED cross-author path (the `moderate`
      // capability operation), so only the `tombstone` half is ownership-gated.
      if (eventType === 'tombstone' && !ownsTarget(r, r.record.target_record_cid)) continue;
      const existing = tombstoneByTarget.get(r.record.target_record_cid);
      // The deterministically-smallest tombstone CID wins (stricter state, §25.1).
      if (existing === undefined || r.recordCid < existing) {
        tombstoneByTarget.set(r.record.target_record_cid, r.recordCid);
      }
    } else if (CONTENT_TYPES.has(eventType)) {
      roots.push(r);
    }
  }

  const projectedByRoot = new Map<string, ProjectedContribution>();
  for (const root of roots) {
    const chain = [root.recordCid];
    const seen = new Set([root.recordCid]);
    let tip = root;
    for (;;) {
      const edits = editsByTarget.get(tip.recordCid);
      if (!edits || edits.length === 0) break;
      const next = pickLatestEdit(edits);
      if (seen.has(next.recordCid)) break; // cycle guard
      seen.add(next.recordCid);
      chain.push(next.recordCid);
      tip = next;
    }
    let hiddenBy: string | undefined;
    const refused: string[] = [];
    for (const cid of chain) {
      const tomb = tombstoneByTarget.get(cid);
      if (tomb !== undefined && hiddenBy === undefined) hiddenBy = tomb;
      const refusedHere = refusedByTarget.get(cid);
      if (refusedHere !== undefined) refused.push(...refusedHere);
    }
    // Sorted, not in arrival order — this field is part of the projection output and
    // the §25.2 guarantee is that the whole output is input-order independent.
    refused.sort();
    projectedByRoot.set(root.recordCid, {
      rootCid: root.recordCid,
      visibleCid: tip.recordCid,
      record: tip.record,
      editChain: chain,
      hidden: hiddenBy !== undefined,
      ...(hiddenBy !== undefined ? { hiddenBy } : {}),
      ...(refused.length > 0 ? { unauthorizedSupersedes: refused } : {}),
    });
  }

  // Order by the roots' display order so an edit never changes a contribution's
  // position (the original post's place in the thread is stable).
  return displayOrder(roots).map(
    (root) => projectedByRoot.get(root.recordCid) as ProjectedContribution,
  );
}
