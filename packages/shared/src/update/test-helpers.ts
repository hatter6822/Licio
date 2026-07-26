// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-only manifest fabrication: build a REAL signed update manifest (genuine
// WebCrypto Ed25519 signatures + a genuine RFC 9162 inclusion proof against a
// genuine signed checkpoint) so the verifier tests exercise the actual crypto +
// Merkle paths, not stubs.  Not exported from the package index.

import { LOG_LEAF_DOMAIN, sha256Concat } from './crypto.js';
import { leafHash, nodeHash } from './merkle.js';
import {
  canonicalCheckpointBody,
  canonicalManifestBody,
  type UpdateManifest,
  type UpdateManifestBody,
} from './schema.js';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Ed25519KeyPair {
  readonly publicKeyRaw: Uint8Array;
  readonly publicKeyB64: string;
  readonly privateKey: CryptoKey;
}

export async function generateKeyPair(): Promise<Ed25519KeyPair> {
  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKeyRaw: raw, publicKeyB64: toBase64Url(raw), privateKey: pair.privateKey };
}

async function sign(privateKey: CryptoKey, message: Uint8Array): Promise<string> {
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', privateKey, message.slice().buffer),
  );
  return toBase64Url(sig);
}

/** Build the Merkle tree over leaf hashes + the inclusion path for `index`. */
async function buildTree(
  leafHashes: Uint8Array[],
): Promise<{ root: Uint8Array; pathFor: (index: number) => Promise<Uint8Array[]> }> {
  const largestPow2LessThan = (n: number): number => {
    let k = 1;
    while (k * 2 < n) k *= 2;
    return k;
  };
  const mth = async (lo: number, hi: number): Promise<Uint8Array> => {
    const n = hi - lo;
    if (n === 1) return leafHashes[lo] as Uint8Array;
    const k = largestPow2LessThan(n);
    return nodeHash(await mth(lo, lo + k), await mth(lo + k, hi));
  };
  const path = async (m: number, lo: number, hi: number): Promise<Uint8Array[]> => {
    if (hi - lo === 1) return [];
    const k = largestPow2LessThan(hi - lo);
    if (m - lo < k) {
      const sub = await path(m, lo, lo + k);
      sub.push(await mth(lo + k, hi));
      return sub;
    }
    const sub = await path(m, lo + k, hi);
    sub.push(await mth(lo, lo + k));
    return sub;
  };
  const root = leafHashes.length === 0 ? await sha256Concat() : await mth(0, leafHashes.length);
  return { root, pathFor: (index) => path(index, 0, leafHashes.length) };
}

export interface BuildManifestOptions {
  /** Bytes of the running bundle (its SHA-256 becomes the digest). */
  readonly bundleBytes: Uint8Array;
  readonly signer: Ed25519KeyPair;
  readonly log: Ed25519KeyPair;
  readonly releaseSequence?: number;
  readonly bundleVersion?: string;
  readonly artifactId?: string;
  readonly logId?: string;
  /** How many OTHER leaves to surround the bundle leaf with in the log. */
  readonly otherLeaves?: number;
  /** Which position the bundle leaf occupies (default 1, i.e. not the only leaf). */
  readonly leafIndex?: number;
}

export interface BuiltManifest {
  readonly manifest: UpdateManifest;
  readonly runningBundleDigest: string;
}

/** Produce a fully-valid signed manifest + the running-bundle digest. */
export async function buildValidManifest(opts: BuildManifestOptions): Promise<BuiltManifest> {
  const digest = await sha256Concat(opts.bundleBytes);
  const digestB64 = toBase64Url(digest);
  const logId = opts.logId ?? 'licio-code-transparency';
  const leafIndex = opts.leafIndex ?? 1;
  const others = opts.otherLeaves ?? 3;
  const total = others + 1;

  const logLeaf = await sha256Concat(LOG_LEAF_DOMAIN, digest);
  const logLeafB64 = toBase64Url(logLeaf);

  // Surround the bundle leaf with distinct unrelated leaves.
  const leaves: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    if (i === leafIndex) leaves.push(logLeaf);
    else leaves.push(await sha256Concat(new TextEncoder().encode(`other-leaf-${i}`)));
  }
  const leafHashes = await Promise.all(leaves.map((l) => leafHash(l)));
  const { root, pathFor } = await buildTree(leafHashes);
  const proofHashes = await pathFor(leafIndex);

  const body: UpdateManifestBody = {
    manifest_version: 1,
    bundle_version: opts.bundleVersion ?? '0.1.0',
    release_sequence: opts.releaseSequence ?? 7,
    artifact_id: opts.artifactId ?? 'private-p2p',
    bundle_digest: digestB64,
    log_id: logId,
    log_leaf: logLeafB64,
  };
  const signature = await sign(opts.signer.privateKey, canonicalManifestBody(body));

  const checkpointPartial = {
    log_id: logId,
    tree_size: total,
    merkle_root: toBase64Url(root),
  };
  const checkpointSig = await sign(
    opts.log.privateKey,
    canonicalCheckpointBody({ ...checkpointPartial, signature: '' }),
  );

  const manifest: UpdateManifest = {
    body,
    signature,
    signer_public_key: opts.signer.publicKeyB64,
    inclusion_proof: {
      leaf_index: leafIndex,
      tree_size: total,
      proof_hashes: proofHashes.map(toBase64Url),
    },
    checkpoint: { ...checkpointPartial, signature: checkpointSig },
  };
  return { manifest, runningBundleDigest: digestB64 };
}

/**
 * Re-sign a (possibly tampered) manifest body with the maintainer key, so a test can
 * ISOLATE a post-signature check (the digest-binding, leaf-commitment, or inclusion
 * guards) instead of tripping `signature_invalid` first.  Without this, a body-tamper test
 * passes on the signature branch and would still pass if the later guard were deleted.
 */
export async function reSignManifest(
  signer: Ed25519KeyPair,
  manifest: UpdateManifest,
): Promise<UpdateManifest> {
  return {
    ...manifest,
    signature: await sign(signer.privateKey, canonicalManifestBody(manifest.body)),
  };
}

export { toBase64Url };
