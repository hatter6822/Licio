// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.6a — the server-blind WebRTC signaling rendezvous: an opaque sealed blob is
// routed to an opaque recipient key and round-trips through POST/GET; the mailbox caps
// blob size, per-peer depth, and TTL; and a §19.1 static check proves the server code
// never parses SDP/ICE and never reads a peer network address (server-blindness).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLcapRoutes } from '../lcap/routes.js';
import {
  frameBlobs,
  SignalMailbox,
  type SignalMailboxConfig,
  unframeBlobs,
} from '../lcap/signaling.js';

const CONFIG: SignalMailboxConfig = {
  maxBlobBytes: 64,
  maxQueuePerPeer: 3,
  ttlMs: 1000,
  maxPeers: 100,
};

describe('SignalMailbox — opaque store-and-forward', () => {
  it('routes an opaque blob from poster to recipient', () => {
    const mb = new SignalMailbox(CONFIG);
    expect(mb.post('peerB', new Uint8Array([1, 2, 3]), 0)).toEqual({ ok: true });
    const drained = mb.drain('peerB', 10);
    expect(drained).toEqual([new Uint8Array([1, 2, 3])]);
    expect(mb.drain('peerB', 20)).toEqual([]); // drained once, then empty
  });

  it('rejects a bad key (400), an empty/oversized blob (400/413)', () => {
    const mb = new SignalMailbox(CONFIG);
    expect(mb.post('has space', new Uint8Array([1]), 0)).toEqual({ ok: false, status: 400 });
    expect(mb.post('peerB', new Uint8Array(), 0)).toEqual({ ok: false, status: 400 });
    expect(mb.post('peerB', new Uint8Array(65), 0)).toEqual({ ok: false, status: 413 });
  });

  it('bounds the per-peer queue (drop-oldest) and sweeps by TTL', () => {
    const mb = new SignalMailbox(CONFIG);
    for (let i = 0; i < 5; i++) mb.post('peerB', new Uint8Array([i]), 0);
    const drained = mb.drain('peerB', 10);
    expect(drained).toHaveLength(3); // capped at maxQueuePerPeer, oldest dropped
    expect(drained[0]).toEqual(new Uint8Array([2]));

    mb.post('peerC', new Uint8Array([9]), 0);
    expect(mb.drain('peerC', 5000)).toEqual([]); // expired past the 1000ms TTL
  });

  it('frames + unframes multiple blobs losslessly', () => {
    const blobs = [new Uint8Array([1]), new Uint8Array([2, 2]), new Uint8Array()];
    expect(unframeBlobs(frameBlobs(blobs))).toEqual(blobs);
  });

  it('unframes UNTRUSTED input fail-closed: malformed/truncated frames never throw', () => {
    // The drain response is parsed from an untrusted network body, so unframeBlobs must
    // fail closed: return the well-formed prefix (or nothing), never throw or over-read.
    expect(unframeBlobs(new Uint8Array())).toEqual([]); // not even a count
    // A declared count of 3 but only one complete frame present → just that frame.
    const oneGood = frameBlobs([new Uint8Array([7, 7])]);
    const forgedCount = new Uint8Array(oneGood.length);
    forgedCount.set(oneGood);
    forgedCount[0] = 3; // claim 3 blobs; only 1 is actually encoded
    expect(unframeBlobs(forgedCount)).toEqual([new Uint8Array([7, 7])]);
    // A length prefix that overruns the buffer stops the parse (no over-read).
    // Layout: count=1, len=100 (one byte, <0x80), then only 2 payload bytes present.
    expect(unframeBlobs(new Uint8Array([1, 100, 9, 9]))).toEqual([]);
    // A truncated length varint (high-bit set, no continuation) stops cleanly.
    expect(unframeBlobs(new Uint8Array([1, 0x80]))).toEqual([]);
    // A forged enormous count cannot spin or over-allocate — the loop is buffer-bounded.
    expect(unframeBlobs(new Uint8Array([0xff, 0xff, 0xff, 0x7f]))).toEqual([]);
  });
});

describe('signaling routes (§29 /p2p/signal)', () => {
  it('round-trips an opaque blob through POST then a POST drain', async () => {
    const app = createLcapRoutes();
    const key = `peer${Math.random().toString(36).slice(2)}`;
    const blob = new Uint8Array([5, 6, 7, 8]);
    const post = await app.request(`/p2p/signal?to=${key}`, { method: 'POST', body: blob });
    expect(post.status).toBe(202);

    // The drain is a state-changing POST (CSRF-protected), not a GET.
    const drained = await app.request(`/p2p/signal/poll?peer=${key}`, { method: 'POST' });
    expect(drained.status).toBe(200);
    const framed = new Uint8Array(await drained.arrayBuffer());
    expect(unframeBlobs(framed)).toEqual([blob]);
  });

  it('rejects a POST without a recipient key', async () => {
    const app = createLcapRoutes();
    const res = await app.request('/p2p/signal', { method: 'POST', body: new Uint8Array([1]) });
    expect(res.status).toBe(400);
  });
});

describe('§19.1 server-blindness — the signaling code parses no SDP/ICE/IP', () => {
  it('contains no SDP/ICE/candidate/IP-address token (outside comments)', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../lcap/signaling.ts'), 'utf-8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const token of [
      'sdp',
      'icecandidate',
      'candidate',
      'ip_address',
      'ipaddress',
      'remote_addr',
    ]) {
      expect(new RegExp(`\\b${token}\\b`, 'i').test(code)).toBe(false);
    }
  });
});
