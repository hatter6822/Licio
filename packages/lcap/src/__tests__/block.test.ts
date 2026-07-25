// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.3 — blocks, chunking, attachment laziness, and compression.

import { describe, expect, it } from 'vitest';
import {
  BLOCK_ROLE_PRIORITY,
  buildBlockDescriptor,
  CompressionBombError,
  chunkBlock,
  compress,
  decompress,
  initialRenderObjects,
  reassembleBlock,
  splitContribution,
  verifyBlockDescriptor,
} from '../block/index.js';
import { cidFor } from '../cid/index.js';

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

describe('block descriptor (WS-R.3.1)', () => {
  it('builds a descriptor that round-trips verification', async () => {
    const data = bytes(500);
    const descriptor = await buildBlockDescriptor(data, { role: 'image', mediaType: 'image/png' });
    expect(descriptor.priority).toBe(BLOCK_ROLE_PRIORITY.image);
    expect(await verifyBlockDescriptor(descriptor, data)).toEqual({ ok: true });
    // Wrong size / wrong bytes are detected.
    expect(await verifyBlockDescriptor(descriptor, bytes(499))).toEqual({
      ok: false,
      status: 'bad_size',
    });
    const altered = Uint8Array.from(data);
    altered[0] = (altered[0] ?? 0) ^ 0xff;
    expect((await verifyBlockDescriptor(descriptor, altered)).ok).toBe(false);
  });

  it('maps roles to lane priorities', () => {
    expect(BLOCK_ROLE_PRIORITY.proof_blob).toBe(0);
    expect(BLOCK_ROLE_PRIORITY.body_text).toBe(1);
    expect(BLOCK_ROLE_PRIORITY.thumbnail).toBe(2);
    expect(BLOCK_ROLE_PRIORITY.video).toBe(3);
    expect(BLOCK_ROLE_PRIORITY.misc).toBe(4);
  });
});

describe('chunking + reassembly (WS-R.3.2)', () => {
  it('chunks, reassembles, and verifies the block CID', async () => {
    const data = bytes(10_000);
    const blockCid = await cidFor('block', data);
    const { chunks, descriptors } = await chunkBlock(data, 4096);
    expect(chunks).toHaveLength(3); // 4096 + 4096 + 1808
    const result = await reassembleBlock(chunks, descriptors, blockCid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toEqual(data);
  });

  it('localizes a single corrupt chunk by index', async () => {
    const data = bytes(9000);
    const blockCid = await cidFor('block', data);
    const { chunks, descriptors } = await chunkBlock(data, 4096);
    const corrupt = chunks.map((c, i) => (i === 1 ? Uint8Array.from(c).fill(0) : c));
    const result = await reassembleBlock(corrupt, descriptors, blockCid);
    expect(result).toMatchObject({ ok: false, reason: 'chunk_hash_mismatch', corruptIndex: 1 });
  });

  it('rejects reassembly against the wrong expected block CID', async () => {
    const data = bytes(5000);
    const { chunks, descriptors } = await chunkBlock(data, 2048);
    const wrong = await cidFor('block', bytes(5000, 99));
    expect(await reassembleBlock(chunks, descriptors, wrong)).toMatchObject({
      ok: false,
      reason: 'block_cid_mismatch',
    });
  });
});

describe('attachment laziness (WS-R.3.3)', () => {
  it('orders objects by lane and renders text without media', () => {
    const split = splitContribution({
      eventRecord: { cid: 'lcapr_event', sizeBytes: 200 },
      bodyText: { cid: 'lcapb_body', sizeBytes: 500 },
      thumbnail: { cid: 'lcapb_thumb', sizeBytes: 1000 },
      attachmentManifest: { cid: 'lcapb_manifest', sizeBytes: 100 },
      mediaChunks: [
        { cid: 'lcapc_0', sizeBytes: 4096 },
        { cid: 'lcapc_1', sizeBytes: 4096 },
      ],
    });
    expect(split.map((o) => o.priority)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(split.filter((o) => o.requiredForInitialRender).map((o) => o.role)).toEqual([
      'event_record',
      'body_text',
    ]);
    expect(initialRenderObjects(split).every((o) => o.priority === 1)).toBe(true);
  });
});

describe('compression + bomb caps (WS-R.3.4)', () => {
  it('round-trips gzip and deflate and keeps CID stable over compression', async () => {
    const data = bytes(20_000);
    for (const algo of ['gzip', 'deflate'] as const) {
      const compressed = await compress(data, algo);
      const restored = await decompress(compressed, algo, {
        maxUncompressedBytes: 1 << 20,
        maxExpansionRatio: 1000,
      });
      expect(restored).toEqual(data);
      // CID is over the uncompressed canonical bytes, unchanged by compression.
      expect(await cidFor('block', restored)).toBe(await cidFor('block', data));
    }
  });

  it('aborts a compression bomb at the expansion-ratio cap', async () => {
    const zeros = new Uint8Array(200_000); // compresses to a tiny payload
    const compressed = await compress(zeros, 'gzip');
    await expect(
      decompress(compressed, 'gzip', { maxUncompressedBytes: 1 << 30, maxExpansionRatio: 2 }),
    ).rejects.toBeInstanceOf(CompressionBombError);
  });

  // `compress` pumps its input concurrently so the transform cannot deadlock on
  // a full buffer.  That pump must be SETTLED, not floated: a bare
  // `write().then(close)` rejects with no handler when the stream errors, and
  // Node's default `--unhandled-rejections=throw` turns that into a process
  // abort — the API server dying on a corrupt block rather than failing the one
  // request.  `decompress` has always guarded its identical pump; this pins the
  // two as symmetric.
  it('surfaces a stream failure to the caller, never as an unhandled rejection', async () => {
    const realCompressionStream = globalThis.CompressionStream;
    const failure = new Error('compression transform failed');
    // A stream whose writer AND reader both reject — the shape a transform in an
    // errored state presents to both sides.
    class FailingCompressionStream {
      readonly writable = {
        getWriter: () => ({
          write: () => Promise.reject(failure),
          close: () => Promise.reject(failure),
        }),
      };
      readonly readable = {
        getReader: () => ({ read: () => Promise.reject(failure) }),
      };
    }
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    (globalThis as { CompressionStream: unknown }).CompressionStream = FailingCompressionStream;
    try {
      await expect(compress(bytes(64), 'gzip')).rejects.toThrow('compression transform failed');
      // Node flags an unhandled rejection on a later turn of the loop, so give it
      // one before asserting none was raised.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      (globalThis as { CompressionStream: unknown }).CompressionStream = realCompressionStream;
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });
});
