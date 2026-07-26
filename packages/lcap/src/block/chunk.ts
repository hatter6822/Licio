// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fixed-size chunking + reassembly verification (OFFLINE_SPEC §13.2, §13.3,
// WS-R.3.2).  v0.2 uses fixed-size chunks (content-defined chunking is deferred
// — too CPU-heavy for cheap phones, §13.3).  The receiver verifies BOTH each
// chunk hash AND the reassembled block hash, so a single corrupt chunk is
// localized and individually re-fetchable.

import { bytesEqual } from '../checkpoint/merkle.js';
import { cidFor, sha256 } from '../cid/index.js';
import type { ChunkDescriptorV2 } from '../schemas/records.js';

/** Transport profiles the §13.2 chunk bounds are defined for. */
export type ChunkProfile = 'unstable' | 'mobile' | 'https' | 'lan';

/**
 * The §13.2 fixed chunk size per transport profile.
 *
 * Smaller chunks on a lossy carrier so one corrupt chunk costs one small
 * re-fetch; larger on a LAN where the round trip dominates.  This mapping IS
 * the specification's numbers — it was briefly deleted as unreferenced, which
 * left `ChunkProfile` a vocabulary with nothing behind it and the documented
 * bounds implemented nowhere.  `chunkBlock` now takes a profile, so naming one
 * is the ordinary way to chunk and the numbers cannot drift out of use again.
 */
export const CHUNK_SIZE: Readonly<Record<ChunkProfile, number>> = {
  unstable: 16 * 1024,
  mobile: 32 * 1024,
  https: 64 * 1024,
  lan: 128 * 1024,
};

export interface ChunkedBlock {
  readonly parentBlockCid: string;
  readonly chunks: readonly Uint8Array[];
  readonly descriptors: readonly ChunkDescriptorV2[];
}

/**
 * Split a block's bytes into fixed-size chunks with per-chunk descriptors.
 *
 * Takes a transport PROFILE (§13.2) or an explicit byte size.  The profile form
 * is the one to reach for: it keeps the specification's bounds on the calling
 * path rather than in a constant beside it.  An explicit size stays available
 * for a carrier that negotiates its own, and for tests exercising the boundary
 * arithmetic at sizes a profile would never produce.
 */
export async function chunkBlock(
  bytes: Uint8Array,
  size: number | ChunkProfile,
): Promise<ChunkedBlock> {
  const chunkSize = typeof size === 'number' ? size : CHUNK_SIZE[size];
  if (chunkSize <= 0) throw new Error('chunk size must be positive');
  const parentBlockCid = await cidFor('block', bytes);
  const chunks: Uint8Array[] = [];
  const descriptors: ChunkDescriptorV2[] = [];
  for (
    let offset = 0, index = 0;
    offset < bytes.length || index === 0;
    offset += chunkSize, index++
  ) {
    const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.length));
    chunks.push(chunk);
    descriptors.push({
      parent_block_cid: parentBlockCid,
      chunk_index: index,
      offset,
      length: chunk.length,
      chunk_sha256: await sha256(chunk),
    });
    if (offset + chunkSize >= bytes.length) break;
  }
  return { parentBlockCid, chunks, descriptors };
}

export type ReassemblyResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'chunk_hash_mismatch'; readonly corruptIndex: number }
  | { readonly ok: false; readonly reason: 'block_cid_mismatch' | 'chunk_count_mismatch' };

/**
 * Reassemble a block from its chunks, verifying each chunk hash (localizing a
 * corrupt chunk by index) and the final reassembled block CID.
 */
export async function reassembleBlock(
  chunks: readonly Uint8Array[],
  descriptors: readonly ChunkDescriptorV2[],
  expectedBlockCid: string,
): Promise<ReassemblyResult> {
  if (chunks.length !== descriptors.length) return { ok: false, reason: 'chunk_count_mismatch' };
  // Verify per-chunk hashes in declared order (localizes a single corrupt chunk).
  const ordered = descriptors
    .map((descriptor, position) => ({ descriptor, chunk: chunks[position] as Uint8Array }))
    .sort((a, b) => a.descriptor.chunk_index - b.descriptor.chunk_index);
  let total = 0;
  for (const { descriptor, chunk } of ordered) {
    if (!bytesEqual(descriptor.chunk_sha256, await sha256(chunk))) {
      return { ok: false, reason: 'chunk_hash_mismatch', corruptIndex: descriptor.chunk_index };
    }
    total += chunk.length;
  }
  const bytes = new Uint8Array(total);
  let position = 0;
  for (const { chunk } of ordered) {
    bytes.set(chunk, position);
    position += chunk.length;
  }
  if ((await cidFor('block', bytes)) !== expectedBlockCid) {
    return { ok: false, reason: 'block_cid_mismatch' };
  }
  return { ok: true, bytes };
}
