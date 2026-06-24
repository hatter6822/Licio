// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2a — minimal RFC 9162 / RFC 6962 Merkle inclusion verification for the
// hardened private-mode update channel (PRIVATE_SPEC §20.6, §22.4; WS-O.3.2b/3.2e
// transparency log).  A signed update manifest carries an inclusion proof placing
// its bundle digest in the maintainers' APPEND-ONLY code-transparency log; this
// module recomputes the log's Merkle root from the leaf + proof and requires
// byte equality with the signed checkpoint root.  No proof, a short proof, a
// mismatched root, or any inconsistency ⇒ the verification fails (fail-closed),
// which the activation decision treats as "not in the transparency log" and the
// client treats as "lock private rooms" (verify-before-unlock).
//
// `@licio/shared` is a LEAF package: it cannot import `@licio/lcap`'s
// `checkpoint/merkle.ts` (that would invert the dependency graph and break
// `check:workspace-deps`), so the RFC 9162 §2.1.3.2 inclusion algorithm is
// re-implemented here, self-contained, using the SAME domain-separated leaf/node
// hashing (0x00 leaf prefix, 0x01 node prefix) so a standard CT-style verifier
// interoperates with a maintainer-operated log.  The math is mathematically
// identical to the audited LCAP implementation, line-checked against it.

import { sha256Concat } from './crypto.js';

/** RFC 6962 §2.1 leaf-hash domain separator. */
const LEAF_PREFIX = 0x00;
/** RFC 6962 §2.1 interior-node domain separator. */
const NODE_PREFIX = 0x01;

/**
 * Constant-time-ish public-hash equality (length, then XOR-accumulate over the
 * bytes).  Inputs are public Merkle hashes, so this guards only against an
 * early-return timing tell, not a secret-dependent branch.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** `MTH({d}) = SHA-256(0x00 || leaf_input)` (RFC 6962 §2.1). */
export function leafHash(leafInput: Uint8Array): Promise<Uint8Array> {
  return sha256Concat(Uint8Array.of(LEAF_PREFIX), leafInput);
}

/** `MTH(D) = SHA-256(0x01 || left || right)` (RFC 6962 §2.1). */
export function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256Concat(Uint8Array.of(NODE_PREFIX), left, right);
}

/**
 * Verify an RFC 9162 §2.1.3.2 inclusion proof: recompute the tree root from
 * `(leafHash, leafIndex, treeSize, proofHashes)` and require it equals `root`.
 *
 * Fail-closed contract: an out-of-range index, a tree size of zero, a proof
 * whose length cannot reconstruct the path, or any root mismatch returns
 * `false`.  The caller (`verifyInclusionInLog`) never interprets `false` as
 * anything other than "absent / untrusted".
 */
export async function verifyInclusion(
  leaf: Uint8Array,
  leafIndex: number,
  treeSize: number,
  proofHashes: readonly Uint8Array[],
  root: Uint8Array,
): Promise<boolean> {
  if (!Number.isInteger(leafIndex) || !Number.isInteger(treeSize)) return false;
  if (treeSize <= 0 || leafIndex < 0 || leafIndex >= treeSize) return false;

  // RFC 9162 §2.1.3.2 verification automaton.
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leaf;
  for (const p of proofHashes) {
    if (sn === 0) return false; // more proof hashes than the tree height allows
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
  // The proof must have consumed exactly the height (`sn === 0`) AND reconstruct
  // the signed root.  A proof that is too short leaves `sn > 0`.
  return sn === 0 && bytesEqual(r, root);
}
