// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Streaming pack reader (OFFLINE_SPEC §14.3, §14.6, §27.1, WS-R.4.2).  Verifies
// the magic, parses the header/table under resource caps, then reads frames
// verifying each frame length ≤ cap and that the payload hash matches the CID.
// Nothing is trusted before trust projection (WS-R.8) — the reader only
// establishes integrity (CID↔payload) and structure; schema/proof/policy
// decisions belong to the importer + `validate`.

import { type CidKind, cidFor } from '../cid/index.js';
import { decodeWithSchema } from '../schemas/codec.js';
import {
  type PackFrameHeaderV2,
  type PackHeaderV2,
  type PackTableEntryV2,
  packFrameHeaderV2Schema,
  packHeaderV2Schema,
  packTableV2Schema,
} from '../schemas/pack.js';
import { readUvarint } from './uvarint.js';
import { PACK_MAGIC } from './writer.js';

export interface ReaderCaps {
  readonly maxPackBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxTableBytes: number;
  readonly maxFrameHeaderBytes: number;
  readonly maxFramePayloadBytes: number;
  readonly maxEntries: number;
}

export const DEFAULT_READER_CAPS: ReaderCaps = {
  maxPackBytes: 64 * 1024 * 1024,
  maxHeaderBytes: 64 * 1024,
  maxTableBytes: 4 * 1024 * 1024,
  maxFrameHeaderBytes: 4 * 1024,
  maxFramePayloadBytes: 16 * 1024 * 1024,
  maxEntries: 100_000,
};

export type PackReadStatus =
  | 'bad_magic'
  | 'oversized_pack'
  | 'oversized_header'
  | 'oversized_table'
  | 'too_many_entries'
  | 'oversized_frame'
  | 'truncated'
  | 'bad_header_schema'
  | 'bad_table_schema'
  | 'bad_frame_schema';

const FRAME_KIND_TO_CID: Readonly<Record<PackFrameHeaderV2['frame_kind'], CidKind>> = {
  record_body: 'record',
  proof: 'proof',
  block: 'block',
  chunk: 'chunk',
};

export interface ParsedFrame {
  readonly frameKind: PackFrameHeaderV2['frame_kind'];
  readonly payload: Uint8Array;
  /** True iff `cidFor(kind, payload)` equals the frame's declared CID. */
  readonly cidVerified: boolean;
}

export interface ParsedPack {
  readonly header: PackHeaderV2;
  readonly entries: readonly PackTableEntryV2[];
  readonly frames: ReadonlyMap<string, ParsedFrame>;
}

export type PackReadResult =
  | { readonly ok: true; readonly pack: ParsedPack }
  | { readonly ok: false; readonly status: PackReadStatus };

function startsWithMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PACK_MAGIC.length) return false;
  for (let i = 0; i < PACK_MAGIC.length; i++) if (bytes[i] !== PACK_MAGIC[i]) return false;
  return true;
}

/** Read + integrity-verify a pack under resource caps. */
export async function readPack(
  bytes: Uint8Array,
  caps: ReaderCaps = DEFAULT_READER_CAPS,
): Promise<PackReadResult> {
  if (bytes.length > caps.maxPackBytes) return { ok: false, status: 'oversized_pack' };
  if (!startsWithMagic(bytes)) return { ok: false, status: 'bad_magic' };
  let pos = PACK_MAGIC.length;

  // Header.
  let headerLen: number;
  try {
    const read = readUvarint(bytes, pos);
    headerLen = read.value;
    pos += read.bytesRead;
  } catch {
    return { ok: false, status: 'truncated' };
  }
  if (headerLen > caps.maxHeaderBytes) return { ok: false, status: 'oversized_header' };
  if (pos + headerLen > bytes.length) return { ok: false, status: 'truncated' };
  let header: PackHeaderV2;
  try {
    header = decodeWithSchema(packHeaderV2Schema, bytes.slice(pos, pos + headerLen));
  } catch {
    return { ok: false, status: 'bad_header_schema' };
  }
  pos += headerLen;

  // Table.
  let tableLen: number;
  try {
    const read = readUvarint(bytes, pos);
    tableLen = read.value;
    pos += read.bytesRead;
  } catch {
    return { ok: false, status: 'truncated' };
  }
  if (tableLen > caps.maxTableBytes) return { ok: false, status: 'oversized_table' };
  if (pos + tableLen > bytes.length) return { ok: false, status: 'truncated' };
  let entries: PackTableEntryV2[];
  try {
    entries = decodeWithSchema(packTableV2Schema, bytes.slice(pos, pos + tableLen)).entries;
  } catch {
    return { ok: false, status: 'bad_table_schema' };
  }
  if (entries.length > caps.maxEntries) return { ok: false, status: 'too_many_entries' };
  pos += tableLen;

  // Frames.
  const frames = new Map<string, ParsedFrame>();
  while (pos < bytes.length) {
    let frameHeaderLen: number;
    try {
      const read = readUvarint(bytes, pos);
      frameHeaderLen = read.value;
      pos += read.bytesRead;
    } catch {
      return { ok: false, status: 'truncated' };
    }
    if (frameHeaderLen > caps.maxFrameHeaderBytes) return { ok: false, status: 'oversized_frame' };
    if (pos + frameHeaderLen > bytes.length) return { ok: false, status: 'truncated' };
    let frameHeader: PackFrameHeaderV2;
    try {
      frameHeader = decodeWithSchema(
        packFrameHeaderV2Schema,
        bytes.slice(pos, pos + frameHeaderLen),
      );
    } catch {
      return { ok: false, status: 'bad_frame_schema' };
    }
    pos += frameHeaderLen;
    if (frameHeader.payload_len > caps.maxFramePayloadBytes)
      return { ok: false, status: 'oversized_frame' };
    if (pos + frameHeader.payload_len > bytes.length) return { ok: false, status: 'truncated' };
    const payload = bytes.slice(pos, pos + frameHeader.payload_len);
    pos += frameHeader.payload_len;
    const expectedCid = await cidFor(FRAME_KIND_TO_CID[frameHeader.frame_kind], payload);
    frames.set(frameHeader.cid, {
      frameKind: frameHeader.frame_kind,
      payload,
      cidVerified: expectedCid === frameHeader.cid,
    });
  }

  return { ok: true, pack: { header, entries, frames } };
}
