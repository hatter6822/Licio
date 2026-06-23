// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.6a — the client signaling rendezvous helpers: the mailbox-frame unframer
// (matching the server's `frameBlobs` codec) and the fetch-bound post/poll client.

import { writeUvarint } from '@licio/lcap';
import { describe, expect, it, vi } from 'vitest';
import { createSignalClient, unframeSignalBlobs } from './p2p-signaling.js';

function frame(blobs: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [writeUvarint(blobs.length)];
  for (const b of blobs) parts.push(writeUvarint(b.length), b);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('WS-R.15.6a signaling client', () => {
  it('unframes the server mailbox framing round-trip', () => {
    const blobs = [new Uint8Array([1, 2, 3]), new Uint8Array([]), new Uint8Array([9, 8, 7, 6])];
    const got = unframeSignalBlobs(frame(blobs));
    expect(got.map((b) => Array.from(b))).toEqual(blobs.map((b) => Array.from(b)));
  });

  it('fails closed on a truncated frame (returns the well-formed prefix, never throws)', () => {
    const full = frame([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
    const truncated = full.subarray(0, full.length - 2); // chop the last blob
    const got = unframeSignalBlobs(truncated);
    expect(got.length).toBeLessThan(2);
    expect(() => unframeSignalBlobs(new Uint8Array([]))).not.toThrow();
  });

  it('posts to the rendezvous and unframes the poll response', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/p2p/signal/poll')) {
        return new Response(frame([new Uint8Array([42])]) as BodyInit, { status: 200 });
      }
      // the POST signal endpoint
      expect(init?.method).toBe('POST');
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const client = createSignalClient({ apiBase: 'https://api.test', fetchFn });
    await client.postSignal('peer-b', new Uint8Array([7, 7]));
    const drained = await client.pollSignal('peer-a');
    expect(drained.map((b) => Array.from(b))).toEqual([[42]]);
    // The POST targeted the ?to= recipient and the poll the ?peer= self key.
    const calls = (fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      (c) => c[0],
    );
    expect(calls.some((u) => String(u).includes('to=peer-b'))).toBe(true);
    expect(calls.some((u) => String(u).includes('peer=peer-a'))).toBe(true);
  });
});
