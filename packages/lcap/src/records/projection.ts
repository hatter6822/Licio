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
 * Compare two records by the §12.4 precedence ladder, EXCLUDING causal order
 * (which the topological pass handles): room-log sequence → device sequence
 * (only meaningful within one device) → checkpoint index → claimed timestamp
 * (a weak hint) → receipt time → `record_cid` (a final deterministic tiebreak).
 * Phone clocks (claimed timestamp) only break ties nothing else resolves.
 */
export function compareDisplayOrder(a: ThreadRecord, b: ThreadRecord): number {
  const byRoomLog = compareOptionalAsc(a.roomLogSeq, b.roomLogSeq);
  if (byRoomLog !== 0) return byRoomLog;

  if (a.record.author_device_key_id === b.record.author_device_key_id) {
    if (a.record.device_seq !== b.record.device_seq) {
      return a.record.device_seq - b.record.device_seq;
    }
  }

  const byCheckpoint = compareOptionalAsc(a.checkpointIndex, b.checkpointIndex);
  if (byCheckpoint !== 0) return byCheckpoint;

  const byClaim = compareOptionalAsc(
    a.record.created_at_claim_ms,
    b.record.created_at_claim_ms,
    true,
  );
  if (byClaim !== 0) return byClaim;

  const byReceipt = compareOptionalAsc(a.receiptMs, b.receiptMs, true);
  if (byReceipt !== 0) return byReceipt;

  if (a.recordCid < b.recordCid) return -1;
  if (a.recordCid > b.recordCid) return 1;
  return 0;
}

/**
 * Compare two optional numbers ascending.  A present value sorts before an
 * absent one (a record with a known sequence/checkpoint is canonical), UNLESS
 * `tieOnAbsent` is set — for weak hints (timestamps), two absent values simply
 * tie so the next ladder rung decides.
 */
function compareOptionalAsc(
  a: number | undefined,
  b: number | undefined,
  tieOnAbsent = false,
): number {
  if (a !== undefined && b !== undefined) return a - b;
  // For a weak hint, a value present on only one side must NOT decide the order
  // (it defers to the next ladder rung) — a spoofable phone-clock timestamp
  // should never win by mere presence.  Strong hints keep present-before-absent.
  if (tieOnAbsent) return 0;
  if (a !== undefined) return -1;
  if (b !== undefined) return 1;
  return 0;
}

/**
 * Order records for display using the §12.4 precedence ladder with causal order
 * respected: a topological sort over `parent_record_cids` edges present in the
 * set (parents before children), with `compareDisplayOrder` ordering the ready
 * set.  Total and deterministic; independent of input order.
 */
export function displayOrder(records: readonly ThreadRecord[]): ThreadRecord[] {
  const byCid = new Map(records.map((r) => [r.recordCid, r]));
  const inDegree = new Map<string, number>();
  const childrenOf = new Map<string, string[]>();
  for (const r of records) inDegree.set(r.recordCid, 0);
  for (const r of records) {
    for (const parent of r.record.parent_record_cids ?? []) {
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
}

/** Deterministically pick the visible edit among conflicting edits of one target. */
function pickLatestEdit(edits: readonly ThreadRecord[]): ThreadRecord {
  let best = edits[0] as ThreadRecord;
  for (const edit of edits) {
    if (
      edit.record.device_seq > best.record.device_seq ||
      (edit.record.device_seq === best.record.device_seq && edit.recordCid < best.recordCid)
    ) {
      best = edit;
    }
  }
  return best;
}

/**
 * Project a thread's records into the visible logical contributions, in display
 * order.  Deterministic and arrival-order-independent: edit chains and
 * tombstones are resolved over the whole record set before ordering.
 */
export function reduceThreadProjection(records: readonly ThreadRecord[]): ProjectedContribution[] {
  const editsByTarget = new Map<string, ThreadRecord[]>();
  const tombstoneByTarget = new Map<string, string>();
  const roots: ThreadRecord[] = [];

  for (const r of records) {
    const eventType = r.record.event_type;
    if (eventType === 'edit' && r.record.replaces_record_cid) {
      const list = editsByTarget.get(r.record.replaces_record_cid) ?? [];
      list.push(r);
      editsByTarget.set(r.record.replaces_record_cid, list);
    } else if (
      (eventType === 'tombstone' || eventType === 'moderation_action') &&
      r.record.target_record_cid
    ) {
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
    for (const cid of chain) {
      const tomb = tombstoneByTarget.get(cid);
      if (tomb !== undefined) {
        hiddenBy = tomb;
        break;
      }
    }
    projectedByRoot.set(root.recordCid, {
      rootCid: root.recordCid,
      visibleCid: tip.recordCid,
      record: tip.record,
      editChain: chain,
      hidden: hiddenBy !== undefined,
      ...(hiddenBy !== undefined ? { hiddenBy } : {}),
    });
  }

  // Order by the roots' display order so an edit never changes a contribution's
  // position (the original post's place in the thread is stable).
  return displayOrder(roots).map(
    (root) => projectedByRoot.get(root.recordCid) as ProjectedContribution,
  );
}
