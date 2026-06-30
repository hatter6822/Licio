// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.1a — the manual `.licio-bundle` EXPORT flow (OFFLINE_SPEC §22.2).  Gathers a
// room's content closure from the WS-R.11 `lcap_v2` store (records → their proofs →
// their referenced blocks), orders it C0/control-first, computes the §26.2 export
// disclosure the UI MUST show BEFORE producing a file, and streams the pack via the
// WS-R.4.1 writer.  The real `@licio/lcap` pack codec runs CLIENT-SIDE and is loaded
// at call time via `await import('@licio/lcap')`, so the protocol core lands in a LAZY
// chunk and never enters the initial bundle (the bundle-size gate stays green).  Save
// uses platform file APIs only — no npm dependency.
//
// `@licio/lcap` TYPES are imported `import type` (fully erased at build, zero runtime
// weight); the runtime values come from the dynamic import.

import type {
  ExportDisclosure,
  ExportItem,
  LcapLane,
  LcapPriority,
  PackHeaderV2,
  PackObject,
} from '@licio/lcap';
import { getLcapDb, LCAP_STORE } from './db.js';
import {
  forEachByCursor,
  normalizeRoomKey,
  type ProofRow,
  type RecordRow,
  readBlockBytes,
  readBlockDescriptor,
  roomHashToBytes,
} from './store.js';

const LANES: readonly LcapLane[] = ['C0', 'T1', 'E2', 'M3', 'B4'];

/** Narrow a stored priority number to the wire 0..4 (default P1 if out of range). */
function asPriority(value: number): LcapPriority {
  return value >= 0 && value <= 4 ? (value as LcapPriority) : 1;
}

/** Narrow a stored lane string to an {@link LcapLane} (default the priority's lane). */
function asLane(value: string, priority: LcapPriority): LcapLane {
  return LANES.includes(value as LcapLane) ? (value as LcapLane) : (LANES[priority] as LcapLane);
}

/** Record kinds that carry identity/device material (a §26.2 disclosure). */
const IDENTITY_KINDS = new Set(['device_certificate', 'room_capability', 'revocation']);

export interface RoomExport {
  /** The pack objects, ordered control-first (lower priority number leads). */
  readonly objects: readonly PackObject[];
  /** The per-item metadata the §26.2 disclosure is computed from. */
  readonly items: readonly ExportItem[];
  readonly recordCount: number;
  readonly proofCount: number;
  readonly blockCount: number;
}

/**
 * Gather a room's full content closure from the local store: every record with that
 * `roomHash`, each record's proofs, and the blocks those records reference (only the
 * ones we actually hold).  Cursor-only reads (bounded memory).  The objects are
 * returned in scheduler order — control/C0 first — so a partial transfer leads with
 * the material that matters (§15.2).
 */
export async function gatherRoomExport(db: IDBDatabase, roomHash: string): Promise<RoomExport> {
  // The exported pack's room_id_hash is the ACTUAL hash bytes (hex → bytes), so a re-import lands
  // each record with the same canonical room key.  (A legacy non-hex `roomHash` falls back to its
  // UTF-8 bytes — those records re-sync to the canonical form anyway.)
  const roomHashBytes = roomHashToBytes(roomHash) ?? new TextEncoder().encode(roomHash);
  const wantRoom = normalizeRoomKey(roomHash);

  // 1) Records for the room (one cursor pass, filtered in JS — bounded memory).  Compare on the
  // CANONICAL key so casing / `0x` differences between the UI hash and the stored value still match.
  const records: RecordRow[] = [];
  const recordCids = new Set<string>();
  await forEachByCursor<RecordRow>(db, LCAP_STORE.records, (row) => {
    if (normalizeRoomKey(row.roomHash) === wantRoom) {
      records.push(row);
      recordCids.add(row.recordCid);
    }
  });

  // 2) Proofs attesting those records (one cursor pass).
  const proofs: ProofRow[] = [];
  await forEachByCursor<ProofRow>(db, LCAP_STORE.proofs, (row) => {
    if (recordCids.has(row.recordCid)) proofs.push(row);
  });

  // 3) Blocks the records reference — re-derived from each record's SIGNED body (body/attachment/
  //    source-snapshot CIDs), NOT `record.deps`, which can be unauthenticated pack-table metadata a
  //    crafted record copied from an imported bundle to point at another room's held block (#HH).  A
  //    dep that resolves to a held block descriptor is included; one we don't hold is omitted.
  const { cappedBodyBlockCids, decodeAndRouteRecord, isOverCapContribution, SERVER_CAPS } =
    await import('@licio/lcap');
  const depCids = new Set<string>();
  // The exported table `deps` per record — derived from the SIGNED body (record refs + block refs),
  // the SAME closure derivation, NOT the stored `record.deps` (which may carry a stale/unauthenticated
  // dep a recipient would then quarantine on while we omit the bytes) (#AE).
  const recordDeps = new Map<string, string[]>();
  // §27.1: records whose SIGNED body declares MORE block OR record (parent) refs than the fan-out cap
  // are OMITTED from the export entirely — NOT exported with a truncated table dep list, which would
  // let a recipient commit the record without all its prerequisites (the import path trusts the table
  // deps).  This mirrors the server's `rejected_resource_limit` and bounds the export at O(1) per
  // over-cap record (the count check never spreads/iterates the full array) (#3).
  const omittedRecordCids = new Set<string>();
  for (const record of records) {
    let decoded: ReturnType<typeof decodeAndRouteRecord>;
    try {
      decoded = decodeAndRouteRecord(record.body);
    } catch {
      continue; // undecodable — no body deps, but still exported as an opaque record
    }
    if (decoded.kind !== 'contribution_event') continue; // non-contribution — no body deps, still exported
    // Reject (omit) an over-cap record on EITHER the block OR the record edge — rather than truncate
    // its deps, which would let a recipient commit it without all prerequisites (the shared gate the
    // import + share paths use too, mirroring the server's two body-derived fan-out gates) (#3/#2).
    if (isOverCapContribution(decoded, SERVER_CAPS.maxFanOut)) {
      omittedRecordCids.add(record.recordCid);
      continue;
    }
    const { cids: blockCids } = cappedBodyBlockCids(decoded, SERVER_CAPS.maxFanOut);
    // Within the cap — emit the FULL closure (record refs + the complete block closure incl. the
    // target snapshot, #1).  No truncation: an exported accepted record carries every prerequisite.
    const deps: string[] = [];
    if (decoded.prev_device_record_cid) deps.push(decoded.prev_device_record_cid);
    if (decoded.replaces_record_cid) deps.push(decoded.replaces_record_cid);
    if (decoded.target_record_cid) deps.push(decoded.target_record_cid);
    if (decoded.thread_root_cid) deps.push(decoded.thread_root_cid);
    for (const p of decoded.parent_record_cids ?? []) deps.push(p);
    for (const b of blockCids) deps.push(b);
    if (deps.length > 0) recordDeps.set(record.recordCid, deps);
    // The block subset of those refs is what we export bytes for (held only).
    for (const b of blockCids) depCids.add(b);
  }
  // The exportable records + their proofs — an over-cap record (and its now-orphan proofs) is dropped.
  const exportRecords = records.filter((r) => !omittedRecordCids.has(r.recordCid));
  const exportProofs = proofs.filter((p) => !omittedRecordCids.has(p.recordCid));
  const blocks: Array<{ cid: string; bytes: Uint8Array }> = [];
  for (const cid of depCids) {
    const descriptor = await readBlockDescriptor(db, cid);
    if (!descriptor) continue;
    const bytes = await readBlockBytes(db, cid);
    if (bytes) blocks.push({ cid, bytes });
  }

  // Build the pack objects + the disclosure items.
  const objects: PackObject[] = [];
  const items: ExportItem[] = [];

  for (const record of exportRecords) {
    const priority = asPriority(record.priority);
    // Deps from the SIGNED body (#AE), not the stored table metadata — so a recipient never
    // quarantines on a stale dep we don't carry.
    const signedDeps = recordDeps.get(record.recordCid);
    objects.push({
      cid: record.recordCid,
      cidKind: 'record',
      frameKind: 'record_body',
      payload: record.body,
      lane: asLane(record.lane, priority),
      priority,
      roomIdHash: roomHashBytes,
      ...(record.kind ? { recordKind: record.kind as PackObject['recordKind'] } : {}),
      ...(signedDeps ? { deps: signedDeps } : {}),
    });
    items.push({
      roomId: roomHash,
      visibility: 'in_room',
      encrypted: false,
      sizeBytes: record.body.length,
      isMedia: false,
      carriesIdentity: IDENTITY_KINDS.has(record.kind),
    });
  }

  for (const proof of exportProofs) {
    objects.push({
      cid: proof.proofCid,
      cidKind: 'proof',
      frameKind: 'proof',
      payload: proof.proofBody,
      lane: 'T1',
      priority: 1,
      providesProofFor: proof.recordCid,
      roomIdHash: roomHashBytes,
    });
    items.push({
      roomId: roomHash,
      visibility: 'in_room',
      encrypted: false,
      sizeBytes: proof.proofBody.length,
      isMedia: false,
      carriesIdentity: false,
    });
  }

  for (const block of blocks) {
    objects.push({
      cid: block.cid,
      cidKind: 'block',
      frameKind: 'block',
      payload: block.bytes,
      lane: 'B4',
      priority: 4,
      roomIdHash: roomHashBytes,
    });
    items.push({
      roomId: roomHash,
      visibility: 'in_room',
      encrypted: false,
      sizeBytes: block.bytes.length,
      isMedia: true,
      carriesIdentity: false,
    });
  }

  // Control/C0 first, then a stable CID order so the bundle is deterministic.
  objects.sort((a, b) => a.priority - b.priority || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));

  return {
    objects,
    items,
    recordCount: exportRecords.length,
    proofCount: exportProofs.length,
    blockCount: blocks.length,
  };
}

/** The §26.2 disclosure for a gathered export (computed via the shared pure helper). */
export async function exportDisclosure(items: readonly ExportItem[]): Promise<ExportDisclosure> {
  const { computeExportDisclosure } = await import('@licio/lcap');
  return computeExportDisclosure(items);
}

/** Map a disclosure to the conservative pack privacy label. */
function privacyLabelFor(disclosure: ExportDisclosure): PackHeaderV2['privacy_label'] {
  if (disclosure.hasPrivateEncrypted) return 'contains_private_encrypted';
  if (disclosure.hasInRoomMetadata) return 'contains_in_room_metadata';
  return 'public';
}

export interface BuildBundleParams {
  readonly objects: readonly PackObject[];
  readonly disclosure: ExportDisclosure;
  readonly maxUncompressedBytes?: number;
}

/** Stream the gathered objects into a `.licio-bundle` byte array (WS-R.4.1 writer). */
export async function buildBundle(params: BuildBundleParams): Promise<Uint8Array> {
  const { writePack } = await import('@licio/lcap');
  return writePack({
    objects: params.objects,
    transportProfile: 'manual_bundle',
    privacyLabel: privacyLabelFor(params.disclosure),
    maxUncompressedBytes: params.maxUncompressedBytes ?? params.disclosure.approxSizeBytes + 1024,
  });
}

export interface FilenameOptions {
  /** High-risk (stealth/emergency): use a room/topic-free generic name (§26.3). */
  readonly highRisk: boolean;
  /** The room the export came from; a short non-reversible prefix aids the user. */
  readonly roomHash?: string;
  readonly atMs?: number;
}

/**
 * The export filename.  A high-risk export (or one with no room) uses a generic,
 * room/topic-free name (§26.3 / WS-R.4.4).  Otherwise a coarse day-stamp plus a short
 * alphanumeric slice of the room hash — enough to tell bundles apart, not enough to
 * recover the room (it is already a one-way hash, truncated further).
 */
export async function bundleFilename(options: FilenameOptions): Promise<string> {
  const atMs = options.atMs ?? Date.now();
  if (options.highRisk || !options.roomHash) {
    const { genericExportFilename } = await import('@licio/lcap');
    return genericExportFilename(atMs);
  }
  const day = Math.floor(atMs / 86_400_000);
  const shortHash = options.roomHash.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return `licio-${shortHash}-${day}.licio-bundle`;
}

/**
 * Trigger a browser download of the bundle bytes (platform file APIs only — no npm
 * dependency).  Uses an object URL + a transient anchor; the `blob:` URL is revoked
 * immediately after the click so it does not leak.
 */
export async function downloadBundle(bytes: Uint8Array, filename: string): Promise<void> {
  const { BUNDLE_MIME } = await import('@licio/lcap');
  if (typeof URL.createObjectURL !== 'function') {
    throw new Error('File download is unavailable in this environment');
  }
  const blob = new Blob([bytes as BlobPart], { type: BUNDLE_MIME });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Convenience: gather + disclose a room export against the shared `lcap_v2` connection. */
export async function prepareRoomExport(
  roomHash: string,
): Promise<RoomExport & { disclosure: ExportDisclosure }> {
  const db = await getLcapDb();
  const gathered = await gatherRoomExport(db, roomHash);
  const disclosure = await exportDisclosure(gathered.items);
  return { ...gathered, disclosure };
}
