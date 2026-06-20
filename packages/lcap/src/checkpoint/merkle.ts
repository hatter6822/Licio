// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Room-log Merkle tree (OFFLINE_SPEC §19.1.1/§19.1.2, WS-R.9.2a/9.3a/9.3b).
// RFC 6962 / RFC 9162 domain-separated hashing prevents leaf/node confusion and
// second-preimage attacks:
//
//   MTH({})    = SHA-256("")
//   MTH({d})   = SHA-256(0x00 || leaf_input(d))      // leaf
//   MTH(D)     = SHA-256(0x01 || MTH(left) || MTH(right))   // node
//
// where the split follows RFC 6962 §2.1 (largest power of two strictly less
// than the leaf count).  `RFC9162_SHA256` uses `leaf_input = cid_bytes` so a
// standard CT verifier interoperates; `LCAP_MERKLE_V2` prepends a network-bound
// domain-separator hash so proofs cannot be replayed across networks.  The
// inclusion and consistency proof generators/verifiers are the standard
// RFC 9162 §2.1.3/§2.1.4 algorithms.

import { getSubtle, toBufferSource } from '../runtime.js';

/** Hashing/proof rule selector (§19.1.1). */
export type TreeAlgorithm = 'RFC9162_SHA256' | 'LCAP_MERKLE_V2';

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;
const TEXT_ENCODER = new TextEncoder();

async function sha256(...parts: readonly Uint8Array[]): Promise<Uint8Array> {
  let total = 0;
  for (const part of parts) total += part.length;
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await getSubtle().digest('SHA-256', toBufferSource(buffer)));
}

/** Constant-time-ish byte equality (length then content; inputs are public hashes). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

function largestPowerOfTwoLessThan(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** `SHA-256("LCAP-v0.2:" || network_id || ":checkpoint:room_log")` (§19.1.1). */
function domainSeparatorHash(networkId: string): Promise<Uint8Array> {
  return sha256(TEXT_ENCODER.encode(`LCAP-v0.2:${networkId}:checkpoint:room_log`));
}

/** The leaf hash for a record's 36-byte `cid_bytes` under `algo`. */
export async function leafHash(
  cidBytes: Uint8Array,
  algo: TreeAlgorithm,
  networkId: string,
): Promise<Uint8Array> {
  if (algo === 'LCAP_MERKLE_V2') {
    const separator = await domainSeparatorHash(networkId);
    return sha256(Uint8Array.of(LEAF_PREFIX), separator, cidBytes);
  }
  return sha256(Uint8Array.of(LEAF_PREFIX), cidBytes);
}

/** The interior node hash `SHA-256(0x01 || left || right)`. */
export function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256(Uint8Array.of(NODE_PREFIX), left, right);
}

/** The empty-tree hash `SHA-256("")`. */
export function emptyTreeHash(): Promise<Uint8Array> {
  return sha256(new Uint8Array(0));
}

/** Compute `MTH(leafHashes[lo:hi])` (`hi` exclusive, range non-empty). */
async function mthRange(
  leafHashes: readonly Uint8Array[],
  lo: number,
  hi: number,
): Promise<Uint8Array> {
  const n = hi - lo;
  if (n === 1) return leafHashes[lo] as Uint8Array;
  const k = largestPowerOfTwoLessThan(n);
  const left = await mthRange(leafHashes, lo, lo + k);
  const right = await mthRange(leafHashes, lo + k, hi);
  return nodeHash(left, right);
}

/** The Merkle root over precomputed leaf hashes (empty-tree hash for `[]`). */
export function merkleRootFromLeafHashes(leafHashes: readonly Uint8Array[]): Promise<Uint8Array> {
  if (leafHashes.length === 0) return emptyTreeHash();
  return mthRange(leafHashes, 0, leafHashes.length);
}

async function inclusionPath(
  leafHashes: readonly Uint8Array[],
  m: number,
  lo: number,
  hi: number,
): Promise<Uint8Array[]> {
  if (hi - lo === 1) return [];
  const k = largestPowerOfTwoLessThan(hi - lo);
  if (m - lo < k) {
    const sub = await inclusionPath(leafHashes, m, lo, lo + k);
    sub.push(await mthRange(leafHashes, lo + k, hi));
    return sub;
  }
  const sub = await inclusionPath(leafHashes, m, lo + k, hi);
  sub.push(await mthRange(leafHashes, lo, lo + k));
  return sub;
}

/** Generate the RFC 9162 inclusion path for leaf `m` (closest sibling first). */
export function inclusionProofFromLeafHashes(
  leafHashes: readonly Uint8Array[],
  m: number,
): Promise<Uint8Array[]> {
  if (m < 0 || m >= leafHashes.length) throw new Error('leaf index out of range');
  return inclusionPath(leafHashes, m, 0, leafHashes.length);
}

/**
 * Verify an inclusion proof (RFC 9162 §2.1.3.2): recompute the root from
 * `(leaf, leafIndex, treeSize, proofHashes)` and require it equals `root`.
 */
export async function verifyInclusion(
  leaf: Uint8Array,
  leafIndex: number,
  treeSize: number,
  proofHashes: readonly Uint8Array[],
  root: Uint8Array,
): Promise<boolean> {
  if (leafIndex >= treeSize || leafIndex < 0) return false;
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leaf;
  for (const p of proofHashes) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = await nodeHash(p, r);
      if ((fn & 1) === 0) {
        do {
          fn >>= 1;
          sn >>= 1;
        } while ((fn & 1) === 0 && fn !== 0);
      }
    } else {
      r = await nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesEqual(r, root);
}

async function consistencySubproof(
  leafHashes: readonly Uint8Array[],
  m: number,
  lo: number,
  hi: number,
  b: boolean,
): Promise<Uint8Array[]> {
  const n = hi - lo;
  if (m === n) return b ? [] : [await mthRange(leafHashes, lo, hi)];
  const k = largestPowerOfTwoLessThan(n);
  if (m <= k) {
    const sub = await consistencySubproof(leafHashes, m, lo, lo + k, b);
    sub.push(await mthRange(leafHashes, lo + k, hi));
    return sub;
  }
  const sub = await consistencySubproof(leafHashes, m - k, lo + k, hi, false);
  sub.push(await mthRange(leafHashes, lo, lo + k));
  return sub;
}

/** Generate the RFC 9162 consistency proof from `firstSize` to the full tree. */
export function consistencyProofFromLeafHashes(
  leafHashes: readonly Uint8Array[],
  firstSize: number,
): Promise<Uint8Array[]> {
  const n = leafHashes.length;
  if (firstSize < 0 || firstSize > n) throw new Error('first size out of range');
  if (firstSize === 0 || firstSize === n) return Promise.resolve([]);
  return consistencySubproof(leafHashes, firstSize, 0, n, true);
}

/**
 * Verify a consistency proof (RFC 9162 §2.1.4.2): require that the `second`-size
 * tree provably extends the `first`-size tree with no leaf rewritten or removed.
 * A failure between two checkpoints the same authority signed is fork evidence.
 */
export async function verifyConsistency(
  first: number,
  second: number,
  proofHashes: readonly Uint8Array[],
  firstRoot: Uint8Array,
  secondRoot: Uint8Array,
): Promise<boolean> {
  if (first > second || first < 0) return false;
  if (first === second) return proofHashes.length === 0 && bytesEqual(firstRoot, secondRoot);
  if (first === 0) return proofHashes.length === 0; // empty old tree is consistent with anything

  const path = isPowerOfTwo(first) ? [firstRoot, ...proofHashes] : [...proofHashes];
  if (path.length === 0) return false;

  let fn = first - 1;
  let sn = second - 1;
  while ((fn & 1) === 1) {
    fn >>= 1;
    sn >>= 1;
  }
  let fr = path[0] as Uint8Array;
  let sr = path[0] as Uint8Array;
  for (let i = 1; i < path.length; i++) {
    const c = path[i] as Uint8Array;
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      if ((fn & 1) === 0) {
        do {
          fn >>= 1;
          sn >>= 1;
        } while ((fn & 1) === 0 && fn !== 0);
      }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesEqual(fr, firstRoot) && bytesEqual(sr, secondRoot);
}
