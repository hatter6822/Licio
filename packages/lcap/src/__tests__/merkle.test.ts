// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.9.2a/9.3a/9.3b — the RFC 6962 / RFC 9162 Merkle tree.  Exhaustive
// inclusion proofs over every (tree size, leaf index) up to 9 leaves, with
// tamper detection; consistency proofs over every (first, second) pair, with
// rewrite detection; the domain-separation difference between the two tree
// algorithms; and hand-computed small-tree roots.

import { describe, expect, it } from 'vitest';
import {
  bytesEqual,
  consistencyProofFromLeafHashes,
  emptyTreeHash,
  inclusionProofFromLeafHashes,
  leafHash,
  merkleRootFromLeafHashes,
  nodeHash,
  type TreeAlgorithm,
  verifyConsistency,
  verifyInclusion,
} from '../checkpoint/merkle.js';

const NET = 'prod';

async function buildLeaves(
  n: number,
  algo: TreeAlgorithm = 'RFC9162_SHA256',
): Promise<Uint8Array[]> {
  const leaves: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    leaves.push(await leafHash(Uint8Array.of(i & 0xff, (i + 1) & 0xff, (i + 2) & 0xff), algo, NET));
  }
  return leaves;
}

function tamper(hash: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(hash);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
}

describe('Merkle hashing (§19.1.1)', () => {
  it('matches the hand-computed empty and two-leaf roots', async () => {
    const empty = await emptyTreeHash();
    expect(bytesEqual(empty, await merkleRootFromLeafHashes([]))).toBe(true);

    const leaves = await buildLeaves(2);
    const expected = await nodeHash(leaves[0] as Uint8Array, leaves[1] as Uint8Array);
    expect(bytesEqual(await merkleRootFromLeafHashes(leaves), expected)).toBe(true);

    const one = await buildLeaves(1);
    expect(bytesEqual(await merkleRootFromLeafHashes(one), one[0] as Uint8Array)).toBe(true);
  });

  it('binds LCAP_MERKLE_V2 leaves to the network (different root)', async () => {
    const rfc = await leafHash(Uint8Array.of(1, 2, 3), 'RFC9162_SHA256', NET);
    const lcap = await leafHash(Uint8Array.of(1, 2, 3), 'LCAP_MERKLE_V2', NET);
    const other = await leafHash(Uint8Array.of(1, 2, 3), 'LCAP_MERKLE_V2', 'staging');
    expect(bytesEqual(rfc, lcap)).toBe(false);
    expect(bytesEqual(lcap, other)).toBe(false);
  });
});

describe('inclusion proofs (RFC 9162 §2.1.3)', () => {
  it('verifies every leaf of every tree size 1..9 and rejects tampering', async () => {
    for (let n = 1; n <= 9; n++) {
      const leaves = await buildLeaves(n);
      const root = await merkleRootFromLeafHashes(leaves);
      for (let m = 0; m < n; m++) {
        const proof = await inclusionProofFromLeafHashes(leaves, m);
        const leaf = leaves[m] as Uint8Array;
        expect(await verifyInclusion(leaf, m, n, proof, root), `n=${n} m=${m}`).toBe(true);
        // Wrong root, wrong leaf, wrong index, tampered proof all fail.
        expect(await verifyInclusion(leaf, m, n, proof, tamper(root))).toBe(false);
        expect(await verifyInclusion(tamper(leaf), m, n, proof, root)).toBe(false);
        if (proof.length > 0) {
          const bad = proof.map((h, i) => (i === 0 ? tamper(h) : h));
          expect(await verifyInclusion(leaf, m, n, bad, root)).toBe(false);
        }
      }
    }
  });

  it('rejects an out-of-range leaf index', async () => {
    const leaves = await buildLeaves(4);
    const root = await merkleRootFromLeafHashes(leaves);
    expect(await verifyInclusion(leaves[0] as Uint8Array, 4, 4, [], root)).toBe(false);
  });
});

describe('consistency proofs (RFC 9162 §2.1.4)', () => {
  it('proves every extension and rejects a rewritten history', async () => {
    for (let second = 2; second <= 9; second++) {
      const leaves = await buildLeaves(second);
      const secondRoot = await merkleRootFromLeafHashes(leaves);
      for (let first = 1; first < second; first++) {
        const firstRoot = await merkleRootFromLeafHashes(leaves.slice(0, first));
        const proof = await consistencyProofFromLeafHashes(leaves, first);
        expect(
          await verifyConsistency(first, second, proof, firstRoot, secondRoot),
          `${first}->${second}`,
        ).toBe(true);
        // A different old root (history rewrite) breaks consistency.
        expect(await verifyConsistency(first, second, proof, tamper(firstRoot), secondRoot)).toBe(
          false,
        );
        expect(await verifyConsistency(first, second, proof, firstRoot, tamper(secondRoot))).toBe(
          false,
        );
      }
    }
  });

  it('treats an empty or equal first size as a trivial proof', async () => {
    const leaves = await buildLeaves(5);
    const root = await merkleRootFromLeafHashes(leaves);
    expect(await verifyConsistency(0, 5, [], root, root)).toBe(true);
    expect(await verifyConsistency(5, 5, [], root, root)).toBe(true);
    expect(await verifyConsistency(5, 5, [], tamper(root), root)).toBe(false);
  });

  it('detects a genuine fork: same size, divergent roots, no valid proof', async () => {
    const a = await buildLeaves(4);
    const b = await buildLeaves(4);
    // Replace one leaf of b so its root diverges from a at the same tree size.
    b[2] = await leafHash(Uint8Array.of(99, 99, 99), 'RFC9162_SHA256', NET);
    const rootA = await merkleRootFromLeafHashes(a);
    const rootB = await merkleRootFromLeafHashes(b);
    expect(bytesEqual(rootA, rootB)).toBe(false);
    // No consistency proof can reconcile two size-4 trees with different roots.
    const proof = await consistencyProofFromLeafHashes(a, 4); // empty (first === size)
    expect(await verifyConsistency(4, 4, proof, rootA, rootB)).toBe(false);
  });
});
