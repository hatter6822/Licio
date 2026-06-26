// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.1b — the manual `.licio-bundle` IMPORT flow (OFFLINE_SPEC §22.2, §14.7).
// Reads a user-selected file through the real WS-R.4.2 reader under the §27.1 caps
// (CID/schema/structure verified), builds a SUMMARY the UI shows BEFORE rendering or
// committing anything, runs the WS-R.4.3 partial import (quarantining missing-
// dependency records), then commits the verified objects to the WS-R.11 `lcap_v2`
// store at INTEGRITY-ONLY trust.  Nothing is marked authorized and nothing renders
// before trust projection (WS-R.8.3): the records land at `integrity_verified`, which
// the read path treats as not-yet-renderable.  A malformed/oversized/truncated file
// fails cleanly with a typed status (no crash, no partial trusted render).
//
// Privacy-label routing (fail-closed, §8 / §28 cross-plane separation): this is the
// PUBLIC availability-store import path.  A bundle whose pack `privacy_label` is
// `contains_private_encrypted` carries WS-S private-room ciphertext that belongs ONLY in
// the device-local private engine, never the shared `lcap_v2` store — so this path
// REFUSES it with a typed `private_bundle` status BEFORE summarizing or committing, and
// the caller routes it to the cross-plane bridge → the private engine instead.
//
// The `@licio/lcap` codec runs CLIENT-SIDE, loaded at call time via dynamic import
// (the lazy chunk); types are `import type` (erased).

import type {
  ImportOptions,
  ImportResult,
  LcapLane,
  ObjectStatusV2,
  PackReadStatus,
  ParsedPack,
  ReaderCaps,
} from '@licio/lcap';
import { LCAP_STORE } from './db.js';
import {
  bytesToHex,
  filterPresentKeys,
  importInCappedTransactions,
  type ProofRow,
  putBlock,
  type RecordRow,
} from './store.js';

const LANES: readonly LcapLane[] = ['C0', 'T1', 'E2', 'M3', 'B4'];

export interface BundleSummary {
  readonly totalObjects: number;
  readonly byKind: Readonly<Record<'record' | 'proof' | 'block' | 'chunk', number>>;
  readonly byLane: Readonly<Record<LcapLane, number>>;
  readonly containsLanes: readonly LcapLane[];
  readonly totalPayloadBytes: number;
  readonly criticalCount: number;
  /** The distinct rooms the table declares (decoded from each entry's room_id_hash). */
  readonly rooms: readonly string[];
  readonly privacyLabel: string;
  readonly transportProfile: string;
  readonly integrityVerified: number;
  readonly integrityFailed: number;
}

/**
 * Build the pre-render summary from a parsed pack — counts, lanes, size, rooms, and
 * how many frames pass CID integrity.  PURE (no I/O): the UI renders this BEFORE any
 * commit or content render, so the user decides with full disclosure (§14.7).
 */
export function summarizeBundle(pack: ParsedPack): BundleSummary {
  const byKind = { record: 0, proof: 0, block: 0, chunk: 0 };
  const byLane: Record<LcapLane, number> = { C0: 0, T1: 0, E2: 0, M3: 0, B4: 0 };
  const rooms = new Set<string>();
  let totalPayloadBytes = 0;
  let criticalCount = 0;

  for (const entry of pack.entries) {
    byKind[entry.cid_kind] += 1;
    byLane[entry.lane] += 1;
    totalPayloadBytes += entry.length;
    if (entry.priority === 0) criticalCount += 1;
    if (entry.room_id_hash !== undefined) rooms.add(bytesToHex(entry.room_id_hash));
  }

  let integrityVerified = 0;
  let integrityFailed = 0;
  for (const frame of pack.frames.values()) {
    if (frame.cidVerified) integrityVerified += 1;
    else integrityFailed += 1;
  }

  return {
    totalObjects: pack.entries.length,
    byKind,
    byLane,
    containsLanes: pack.header.contains_lanes.filter((lane) => LANES.includes(lane)),
    totalPayloadBytes,
    criticalCount,
    rooms: [...rooms].sort(),
    privacyLabel: pack.header.privacy_label,
    transportProfile: pack.header.transport_profile,
    integrityVerified,
    integrityFailed,
  };
}

/**
 * A bundle whose privacy label routes it AWAY from the public store: a
 * `contains_private_encrypted` pack belongs to the device-local private engine, not the
 * shared `lcap_v2` availability store (§8 / §28 cross-plane separation).
 */
export type BundleRoutingStatus = PackReadStatus | 'private_bundle';

export type BundleReadOutcome =
  | { readonly ok: true; readonly pack: ParsedPack; readonly summary: BundleSummary }
  | { readonly ok: false; readonly status: BundleRoutingStatus };

/**
 * Read + integrity-verify a bundle file under resource caps (WS-R.4.2 reader).  On
 * success, also returns the pre-render summary.  A malformed/oversized/truncated file
 * returns a typed `status` and NOTHING is rendered.
 *
 * FAIL-CLOSED privacy-label routing: a `contains_private_encrypted` bundle is refused
 * here with the `private_bundle` status — its WS-S ciphertext must never land in the
 * public `lcap_v2` store; the caller routes it to the cross-plane bridge instead.
 */
export async function readBundleForImport(
  bytes: Uint8Array,
  caps?: ReaderCaps,
): Promise<BundleReadOutcome> {
  const { readPack } = await import('@licio/lcap');
  const result = caps ? await readPack(bytes, caps) : await readPack(bytes);
  if (!result.ok) return { ok: false, status: result.status };
  // §8 / §28: private-encrypted bundles do not belong in the public availability store.
  if (result.pack.header.privacy_label === 'contains_private_encrypted') {
    return { ok: false, status: 'private_bundle' };
  }
  return { ok: true, pack: result.pack, summary: summarizeBundle(result.pack) };
}

/** Run the WS-R.4.3 partial import (statuses + the storable verified frames). */
export async function importBundleObjects(
  pack: ParsedPack,
  options?: ImportOptions,
): Promise<ImportResult> {
  const { importPack } = await import('@licio/lcap');
  return options ? importPack(pack, options) : importPack(pack);
}

/**
 * The pack CIDs we ALREADY hold (records / proofs / blocks / chunks).  Passed to
 * `importBundleObjects` as `alreadyHave` so a RE-import reports them `already_have` and
 * never re-commits: re-committing would overwrite a record we may already hold at HIGHER
 * trust (e.g. `authorized`/`checkpointed`) back down to `integrity_verified`.  Trust
 * projection is monotonic (WS-R.8.3), so an import must never downgrade.
 */
export async function heldCidsFor(db: IDBDatabase, pack: ParsedPack): Promise<Set<string>> {
  const recordCids: string[] = [];
  const proofCids: string[] = [];
  const blobCids: string[] = []; // a block AND a standalone chunk both land CID-addressed in `blocks`
  for (const [cid, frame] of pack.frames) {
    if (frame.frameKind === 'record_body') recordCids.push(cid);
    else if (frame.frameKind === 'proof') proofCids.push(cid);
    else blobCids.push(cid); // 'block' | 'chunk'
  }
  const [records, proofs, blobs] = await Promise.all([
    filterPresentKeys(db, LCAP_STORE.records, recordCids),
    filterPresentKeys(db, LCAP_STORE.proofs, proofCids),
    filterPresentKeys(db, LCAP_STORE.blocks, blobCids),
  ]);
  return new Set([...records, ...proofs, ...blobs]);
}

export interface CommitCounts {
  readonly records: number;
  readonly proofs: number;
  readonly blocks: number;
  /** Standalone `chunk` frames persisted CID-addressed (durable, retrievable by CID). */
  readonly chunks: number;
  readonly quarantined: number;
  readonly rejected: number;
  readonly alreadyHave: number;
  /** The outstanding prerequisite CIDs across all quarantined objects (deduped). */
  readonly missingCids: readonly string[];
}

interface LivenessRow {
  readonly cid: string;
  readonly state: string;
  readonly updatedAt: number;
}

interface QuarantineRow {
  readonly cid: string;
  readonly reason: string;
  readonly firstSeen: number;
  readonly missingDeps: readonly string[];
  readonly byteSize: number;
}

/**
 * Commit the verified objects to the `lcap_v2` store at INTEGRITY-ONLY trust, and
 * record quarantine rows for missing-dependency objects.  Records land at
 * `integrity_verified` (not authorized) so the read path does NOT render them before
 * trust projection (WS-R.8.3).  Blocks are stored metadata↔blob-separated; a bundle
 * import is an out-of-band (`peer_stored`-equivalent) liveness observation.
 */
export async function commitImportedBundle(
  db: IDBDatabase,
  pack: ParsedPack,
  importResult: ImportResult,
  nowMs: number = Date.now(),
): Promise<CommitCounts> {
  const entryByCid = new Map(pack.entries.map((entry) => [entry.cid, entry]));

  const recordRows: RecordRow[] = [];
  const proofRows: ProofRow[] = [];
  const trustRows: Array<{ recordCid: string; state: string; lastEvaluated: number }> = [];
  const livenessRows: LivenessRow[] = [];
  const blockWrites: Array<{ cid: string; bytes: Uint8Array }> = [];
  const chunkWrites: Array<{ cid: string; bytes: Uint8Array }> = [];

  for (const [cid, frame] of importResult.imported) {
    const entry = entryByCid.get(cid);
    if (frame.frameKind === 'record_body') {
      // Store the room key as the LOSSLESS canonical hex of the room_id_hash bytes (not a lossy
      // TextDecoder), so it compares equal to the room frontier + the "Sync this room" UI hash.
      const roomHash = entry?.room_id_hash !== undefined ? bytesToHex(entry.room_id_hash) : '';
      recordRows.push({
        recordCid: cid,
        body: frame.payload,
        kind: entry?.record_kind ?? 'unknown',
        lane: entry?.lane ?? 'T1',
        priority: entry?.priority ?? 1,
        roomHash,
        state: 'integrity_verified',
        size: frame.payload.length,
        ...(entry?.deps ? { deps: [...entry.deps] } : {}),
      });
      trustRows.push({ recordCid: cid, state: 'integrity_verified', lastEvaluated: nowMs });
      livenessRows.push({ cid, state: 'peer_stored', updatedAt: nowMs });
    } else if (frame.frameKind === 'proof') {
      proofRows.push({
        proofCid: cid,
        proofBody: frame.payload,
        recordCid: entry?.provides_proof_for ?? '',
        signerKeyId: '',
        verificationState: 'integrity_verified',
      });
    } else if (frame.frameKind === 'block') {
      blockWrites.push({ cid, bytes: frame.payload });
    } else if (frame.frameKind === 'chunk') {
      // A standalone, CID-verified chunk is content the bundle carried — persist it
      // CID-addressed (durable, retrievable by its chunk CID via `readBlockBytes`) rather
      // than dropping verified bytes.  It carries no parent-block/index association in the
      // v0.2 pack format, so reassembling it INTO a partial block is a tracked follow-up.
      chunkWrites.push({ cid, bytes: frame.payload });
    }
  }

  // Quarantine rows from the per-object statuses (the precise missing prerequisites).
  const quarantineRows: QuarantineRow[] = [];
  const missing = new Set<string>();
  let rejected = 0;
  let alreadyHave = 0;
  for (const status of importResult.statuses) {
    if (status.status === 'quarantined_missing_dependency') {
      const missingCids = quarantineMissing(status);
      for (const dep of missingCids) missing.add(dep);
      quarantineRows.push({
        cid: status.cid,
        reason: 'missing_dependency',
        firstSeen: nowMs,
        missingDeps: missingCids,
        byteSize: pack.frames.get(status.cid)?.payload.length ?? 0,
      });
    } else if (status.status === 'rejected_bad_cid') {
      rejected += 1;
    } else if (status.status === 'already_have') {
      alreadyHave += 1;
    }
  }

  // Persist (capped transactions; blocks metadata↔blob separated).
  if (recordRows.length > 0) await importInCappedTransactions(db, LCAP_STORE.records, recordRows);
  if (proofRows.length > 0) await importInCappedTransactions(db, LCAP_STORE.proofs, proofRows);
  if (trustRows.length > 0)
    await importInCappedTransactions(db, LCAP_STORE.trustProjection, trustRows);
  if (livenessRows.length > 0)
    await importInCappedTransactions(db, LCAP_STORE.liveness, livenessRows);
  if (quarantineRows.length > 0)
    await importInCappedTransactions(db, LCAP_STORE.quarantine, quarantineRows);
  for (const block of blockWrites) {
    await putBlock(
      db,
      { blockCid: block.cid, state: 'integrity_verified', size: block.bytes.length },
      [block.bytes],
    );
  }
  for (const chunk of chunkWrites) {
    await putBlock(
      db,
      { blockCid: chunk.cid, state: 'integrity_verified', size: chunk.bytes.length },
      [chunk.bytes],
    );
  }

  return {
    records: recordRows.length,
    proofs: proofRows.length,
    blocks: blockWrites.length,
    chunks: chunkWrites.length,
    quarantined: quarantineRows.length,
    rejected,
    alreadyHave,
    missingCids: [...missing].sort(),
  };
}

/** Extract the missing-dependency CIDs from a quarantine status (typed-narrow). */
function quarantineMissing(status: ObjectStatusV2): readonly string[] {
  return 'missing_cids' in status && Array.isArray(status.missing_cids) ? status.missing_cids : [];
}
