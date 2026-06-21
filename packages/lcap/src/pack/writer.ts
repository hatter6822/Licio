// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Streaming pack writer (OFFLINE_SPEC §14.3-§14.6, WS-R.4.1).  Produces the
// layout `magic || uvarint(headerLen) || header || uvarint(tableLen) || table ||
// frames`.  The object table precedes the frames so a receiver can decide to
// import / skip / range-fetch before reading any payload.  The writer is
// parameterized by a caller-provided ORDERED object list (the scheduler produces
// that order, WS-R.5.2c); it labels lanes/privacy from the entries it is given
// and streams frames one at a time (bounded memory).

import type { LcapLane } from '../priority.js';
import { encodeWithSchema } from '../schemas/codec.js';
import {
  type PackHeaderV2,
  type PackTableEntryV2,
  packFrameHeaderV2Schema,
  packHeaderV2Schema,
  packTableV2Schema,
} from '../schemas/pack.js';
import { writeUvarint } from './uvarint.js';

/** The pack magic bytes: `LCAPACK2\n`. */
export const PACK_MAGIC = new TextEncoder().encode('LCAPACK2\n');

export interface PackObject {
  readonly cid: string;
  readonly cidKind: 'record' | 'proof' | 'block' | 'chunk';
  readonly frameKind: 'record_body' | 'proof' | 'block' | 'chunk';
  readonly payload: Uint8Array;
  readonly lane: LcapLane;
  readonly priority: PackTableEntryV2['priority'];
  readonly recordKind?: PackTableEntryV2['record_kind'];
  readonly deps?: readonly string[];
  readonly providesProofFor?: string;
  /**
   * The §14.4 room-id hash, so a receiver can group/route by room from the table
   * BEFORE reading any payload (the table-before-frames layout exists for exactly
   * this).  Optional: control/identity material is account-scoped and omits it.
   */
  readonly roomIdHash?: PackTableEntryV2['room_id_hash'];
  readonly flags?: PackTableEntryV2['flags'];
}

export interface WritePackParams {
  readonly objects: readonly PackObject[];
  readonly transportProfile: PackHeaderV2['transport_profile'];
  readonly privacyLabel: PackHeaderV2['privacy_label'];
  readonly maxUncompressedBytes: number;
  readonly createdByNodeId?: string;
  readonly createdAtClaimMs?: number;
  readonly manifestRecordCid?: string;
}

function frameBytes(object: PackObject): Uint8Array {
  const header = encodeWithSchema(packFrameHeaderV2Schema, {
    frame_kind: object.frameKind,
    cid: object.cid,
    payload_len: object.payload.length,
  });
  const len = writeUvarint(header.length);
  const frame = new Uint8Array(len.length + header.length + object.payload.length);
  frame.set(len, 0);
  frame.set(header, len.length);
  frame.set(object.payload, len.length + header.length);
  return frame;
}

/** Build the pack header + table for the given ordered objects. */
function buildHeaderAndTable(params: WritePackParams): { header: Uint8Array; table: Uint8Array } {
  // Lay out the frames to compute each entry's offset (relative to the frame region).
  const entries: PackTableEntryV2[] = [];
  const containsLanes = new Set<LcapLane>();
  const criticalCids: string[] = [];
  let offset = 0;
  for (const object of params.objects) {
    const frame = frameBytes(object);
    entries.push({
      cid: object.cid,
      cid_kind: object.cidKind,
      lane: object.lane,
      priority: object.priority,
      offset,
      length: frame.length,
      ...(object.recordKind !== undefined ? { record_kind: object.recordKind } : {}),
      ...(object.deps !== undefined ? { deps: [...object.deps] } : {}),
      ...(object.providesProofFor !== undefined
        ? { provides_proof_for: object.providesProofFor }
        : {}),
      ...(object.roomIdHash !== undefined ? { room_id_hash: object.roomIdHash } : {}),
      ...(object.flags !== undefined ? { flags: object.flags } : {}),
    });
    containsLanes.add(object.lane);
    if (object.flags?.critical || object.priority === 0) criticalCids.push(object.cid);
    offset += frame.length;
  }

  const header: PackHeaderV2 = {
    pack_version: 2,
    transport_profile: params.transportProfile,
    privacy_label: params.privacyLabel,
    max_uncompressed_bytes: params.maxUncompressedBytes,
    contains_lanes: [...containsLanes],
    ...(criticalCids.length > 0 ? { critical_cids: criticalCids } : {}),
    ...(params.createdByNodeId !== undefined ? { created_by_node_id: params.createdByNodeId } : {}),
    ...(params.createdAtClaimMs !== undefined
      ? { created_at_claim_ms: params.createdAtClaimMs }
      : {}),
    ...(params.manifestRecordCid !== undefined
      ? { manifest_record_cid: params.manifestRecordCid }
      : {}),
  };

  return {
    header: encodeWithSchema(packHeaderV2Schema, header),
    table: encodeWithSchema(packTableV2Schema, { entries }),
  };
}

/** Stream a pack as chunks (magic, header, table, then one frame at a time). */
export function* writePackChunks(params: WritePackParams): Generator<Uint8Array> {
  const { header, table } = buildHeaderAndTable(params);
  yield PACK_MAGIC;
  yield writeUvarint(header.length);
  yield header;
  yield writeUvarint(table.length);
  yield table;
  for (const object of params.objects) yield frameBytes(object);
}

/** Materialize a full pack into a single buffer (concatenating the stream). */
export function writePack(params: WritePackParams): Uint8Array {
  const chunks = [...writePackChunks(params)];
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
