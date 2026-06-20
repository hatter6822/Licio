// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Compression via the platform Compression Streams API + bomb caps (OFFLINE_SPEC
// §13.5, §9.4, §27.1, WS-R.3.4).  gzip/deflate come from the browser/Node
// Compression Streams API with NO npm dependency (zstd is gated on an explicit
// peer advertisement and not implemented here).  Decompression is bounded by an
// absolute size cap AND an expansion-ratio cap; a compression bomb aborts with
// `rejected_resource_limit`.  CIDs are computed over the uncompressed canonical
// bytes (§9.4), so compression never changes a block's identity.

import { toBufferSource } from '../runtime.js';

/** Compression algorithms available without a dependency. */
export type CompressionAlgorithm = 'gzip' | 'deflate';

export interface DecompressLimits {
  /** Absolute cap on the decompressed size. */
  readonly maxUncompressedBytes: number;
  /** Cap on `uncompressed / compressed` — the anti-bomb ratio. */
  readonly maxExpansionRatio: number;
}

export const DEFAULT_DECOMPRESS_LIMITS: DecompressLimits = {
  maxUncompressedBytes: 8 * 1024 * 1024,
  maxExpansionRatio: 100,
};

/** Thrown when decompression exceeds a configured cap (a compression bomb). */
export class CompressionBombError extends Error {
  override readonly name = 'CompressionBombError';
  readonly reason = 'rejected_resource_limit' as const;
  constructor(message: string) {
    super(message);
  }
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Compress bytes with the platform Compression Streams API. */
export async function compress(
  bytes: Uint8Array,
  algorithm: CompressionAlgorithm,
): Promise<Uint8Array> {
  const stream = new CompressionStream(algorithm);
  const writer = stream.writable.getWriter();
  void writer.write(toBufferSource(bytes)).then(() => writer.close());
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  return concat(parts, total);
}

/**
 * Decompress bytes, bounded by `limits`.  Reads the decompression stream
 * incrementally and aborts the moment the cumulative output exceeds the smaller
 * of the absolute cap and `maxExpansionRatio × compressed.length`.
 */
export async function decompress(
  compressed: Uint8Array,
  algorithm: CompressionAlgorithm,
  limits: DecompressLimits = DEFAULT_DECOMPRESS_LIMITS,
): Promise<Uint8Array> {
  const cap = Math.min(
    limits.maxUncompressedBytes,
    Math.floor(limits.maxExpansionRatio * Math.max(1, compressed.length)),
  );
  const stream = new DecompressionStream(algorithm);
  const writer = stream.writable.getWriter();
  // Pump input concurrently so the transform never deadlocks on a full buffer.
  const pump = writer
    .write(toBufferSource(compressed))
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        throw new CompressionBombError(`decompressed size exceeded the cap of ${cap} bytes`);
      }
      parts.push(value);
    }
  } finally {
    await pump;
  }
  return concat(parts, total);
}
