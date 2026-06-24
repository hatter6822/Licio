// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2a — RFC 9162 inclusion-verification unit tests + base64url + Ed25519.

import { describe, expect, it } from 'vitest';
import { fromBase64Url, verifyEd25519 } from './crypto.js';
import { bytesEqual, leafHash, nodeHash, verifyInclusion } from './merkle.js';

/** Build leaf hashes + inclusion path for a tree, mirroring RFC 9162 §2.1. */
async function tree(leaves: Uint8Array[]): Promise<{
  leafHashes: Uint8Array[];
  root: Uint8Array;
  pathFor: (m: number) => Promise<Uint8Array[]>;
}> {
  const leafHashes = await Promise.all(leaves.map((l) => leafHash(l)));
  const k = (n: number): number => {
    let p = 1;
    while (p * 2 < n) p *= 2;
    return p;
  };
  const mth = async (lo: number, hi: number): Promise<Uint8Array> => {
    if (hi - lo === 1) return leafHashes[lo] as Uint8Array;
    const s = k(hi - lo);
    return nodeHash(await mth(lo, lo + s), await mth(lo + s, hi));
  };
  const path = async (m: number, lo: number, hi: number): Promise<Uint8Array[]> => {
    if (hi - lo === 1) return [];
    const s = k(hi - lo);
    if (m - lo < s) {
      const sub = await path(m, lo, lo + s);
      sub.push(await mth(lo + s, hi));
      return sub;
    }
    const sub = await path(m, lo + s, hi);
    sub.push(await mth(lo, lo + s));
    return sub;
  };
  return {
    leafHashes,
    root: await mth(0, leaves.length),
    pathFor: (m) => path(m, 0, leaves.length),
  };
}

describe('verifyInclusion (RFC 9162 §2.1.3.2)', () => {
  it('verifies every leaf in trees of varied sizes', async () => {
    for (const size of [1, 2, 3, 5, 8, 13]) {
      const leaves = Array.from({ length: size }, (_, i) => new TextEncoder().encode(`leaf-${i}`));
      const { leafHashes, root, pathFor } = await tree(leaves);
      for (let m = 0; m < size; m++) {
        const ok = await verifyInclusion(
          leafHashes[m] as Uint8Array,
          m,
          size,
          await pathFor(m),
          root,
        );
        expect(ok, `size=${size} leaf=${m}`).toBe(true);
      }
    }
  });

  it('rejects a wrong root', async () => {
    const leaves = [0, 1, 2, 3, 4].map((i) => new TextEncoder().encode(`x${i}`));
    const { leafHashes, pathFor } = await tree(leaves);
    const ok = await verifyInclusion(
      leafHashes[2] as Uint8Array,
      2,
      5,
      await pathFor(2),
      new Uint8Array(32).fill(0xff),
    );
    expect(ok).toBe(false);
  });

  it('rejects an out-of-range index, a zero tree, and a too-short proof', async () => {
    const leaves = [0, 1, 2, 3].map((i) => new TextEncoder().encode(`y${i}`));
    const { leafHashes, root, pathFor } = await tree(leaves);
    expect(await verifyInclusion(leafHashes[0] as Uint8Array, 4, 4, await pathFor(0), root)).toBe(
      false,
    );
    expect(await verifyInclusion(leafHashes[0] as Uint8Array, 0, 0, [], root)).toBe(false);
    // A truncated proof must fail (leaves sn > 0).
    const path = await pathFor(1);
    expect(await verifyInclusion(leafHashes[1] as Uint8Array, 1, 4, path.slice(0, -1), root)).toBe(
      false,
    );
  });

  it('rejects a proof for a different leaf', async () => {
    const leaves = [0, 1, 2, 3, 4, 5].map((i) => new TextEncoder().encode(`z${i}`));
    const { leafHashes, root, pathFor } = await tree(leaves);
    // Use leaf 3's path but claim leaf 1.
    const ok = await verifyInclusion(leafHashes[1] as Uint8Array, 1, 6, await pathFor(3), root);
    expect(ok).toBe(false);
  });
});

describe('crypto primitives', () => {
  it('bytesEqual is length- and content-sensitive', () => {
    expect(bytesEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
  });

  it('fromBase64Url round-trips and rejects garbage', () => {
    expect(Array.from(fromBase64Url('AAAA'))).toEqual([0, 0, 0]);
    expect(() => fromBase64Url('!!!!')).toThrow();
  });

  it('verifyEd25519 verifies a real signature and fails closed on tamper', async () => {
    const pair = (await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const msg = new TextEncoder().encode('hello transparency');
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, msg.buffer));
    expect(await verifyEd25519(pub, msg, sig)).toBe(true);
    const tampered = msg.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(await verifyEd25519(pub, tampered, sig)).toBe(false);
    expect(await verifyEd25519(pub, msg, new Uint8Array(64))).toBe(false);
    expect(await verifyEd25519(new Uint8Array(31), msg, sig)).toBe(false);
  });
});
