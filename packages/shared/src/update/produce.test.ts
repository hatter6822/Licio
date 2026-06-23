// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.1 — the PRODUCER round-trips against the verifier.  A manifest built
// by `produceSignedManifest` (real WebCrypto Ed25519 + a real append-only RFC
// 9162 log) is `trusted` by `verifyUpdateManifest`; tampering the bundle, the
// signer, or the log leaf makes the SAME verifier LOCK.  The log is append-only
// (later appends never invalidate an earlier proof against a later checkpoint).

import { beforeAll, describe, expect, it } from 'vitest';
import { appendLeaf, emptyLog, merkleRoot, proveInclusion, treeSize } from './log.js';
import { leafHash, verifyInclusion } from './merkle.js';
import { type ManifestSigner, type ProducedManifest, produceSignedManifest } from './produce.js';
import { verifyUpdateManifest } from './verify.js';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface TestSigner extends ManifestSigner {
  readonly logPublicKeyB64: string;
}

async function makeSigner(): Promise<TestSigner> {
  const signerPair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const logPair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const signerPub = new Uint8Array(await crypto.subtle.exportKey('raw', signerPair.publicKey));
  const logPub = new Uint8Array(await crypto.subtle.exportKey('raw', logPair.publicKey));
  const sign =
    (key: CryptoKey) =>
    async (m: Uint8Array): Promise<Uint8Array> =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', key, m.slice().buffer));
  return {
    signerPublicKeyB64: toBase64Url(signerPub),
    logPublicKeyB64: toBase64Url(logPub),
    signManifest: sign(signerPair.privateKey),
    signCheckpoint: sign(logPair.privateKey),
    toBase64Url,
  };
}

let signer: TestSigner;
beforeAll(async () => {
  signer = await makeSigner();
});

const bundleBytes = new TextEncoder().encode('the reproducible private-mode chunk bytes v1');

async function produce(bytes: Uint8Array = bundleBytes): Promise<ProducedManifest> {
  return produceSignedManifest({
    bundleBytes: bytes,
    log: emptyLog('licio-code-transparency'),
    release: { bundleVersion: '0.2.0', releaseSequence: 12, artifactId: 'private-p2p' },
    signer,
  });
}

describe('produceSignedManifest ↔ verifyUpdateManifest', () => {
  it('a produced manifest VERIFIES as trusted', async () => {
    const produced = await produce();
    const verdict = await verifyUpdateManifest({
      manifest: produced.manifest,
      runningBundleDigest: produced.bundleDigest,
      trustedSignerPublicKeys: [signer.signerPublicKeyB64],
      logPublicKey: signer.logPublicKeyB64,
    });
    expect(verdict.trusted).toBe(true);
    if (!verdict.trusted) throw new Error('expected trusted');
    expect(verdict.releaseSequence).toBe(12);
    expect(verdict.bundleVersion).toBe('0.2.0');
  });

  it('locks when the running bundle does not match the attested digest', async () => {
    const produced = await produce();
    const otherDigest = toBase64Url(new Uint8Array(32).fill(0xab));
    const verdict = await verifyUpdateManifest({
      manifest: produced.manifest,
      runningBundleDigest: otherDigest,
      trustedSignerPublicKeys: [signer.signerPublicKeyB64],
      logPublicKey: signer.logPublicKeyB64,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'digest_mismatch' });
  });

  it('locks when the signer is not trusted', async () => {
    const produced = await produce();
    const verdict = await verifyUpdateManifest({
      manifest: produced.manifest,
      runningBundleDigest: produced.bundleDigest,
      trustedSignerPublicKeys: [signer.logPublicKeyB64], // wrong key
      logPublicKey: signer.logPublicKeyB64,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'signature_invalid' });
  });

  it('locks when the checkpoint is verified under the wrong log key', async () => {
    const produced = await produce();
    const verdict = await verifyUpdateManifest({
      manifest: produced.manifest,
      runningBundleDigest: produced.bundleDigest,
      trustedSignerPublicKeys: [signer.signerPublicKeyB64],
      logPublicKey: signer.signerPublicKeyB64, // not the log key
    });
    expect(verdict).toEqual({ trusted: false, reason: 'not_in_transparency_log' });
  });

  it('enforces anti-rollback: a release below the floor is stale', async () => {
    const produced = await produce();
    const verdict = await verifyUpdateManifest({
      manifest: produced.manifest,
      runningBundleDigest: produced.bundleDigest,
      trustedSignerPublicKeys: [signer.signerPublicKeyB64],
      logPublicKey: signer.logPublicKeyB64,
      lastTrustedSequence: 13, // higher than the produced 12
    });
    expect(verdict).toEqual({ trusted: false, reason: 'stale' });
  });

  it('rejects an empty bundle', async () => {
    await expect(produce(new Uint8Array(0))).rejects.toThrow(/empty/);
  });
});

describe('appendLeaf — append-only log', () => {
  it('produces valid inclusion proofs for every leaf across appends', async () => {
    let state = emptyLog('licio-code-transparency');
    const inputs: Uint8Array[] = [];
    for (let i = 0; i < 6; i++) {
      const input = new TextEncoder().encode(`leaf-${i}`);
      inputs.push(input);
      state = (await appendLeaf(state, input)).state;
    }
    expect(treeSize(state)).toBe(6);
    const root = await merkleRoot(state);
    for (let i = 0; i < 6; i++) {
      const proof = await proveInclusion(state, i);
      const leaf = await leafHash(inputs[i] as Uint8Array);
      expect(await verifyInclusion(leaf, i, 6, proof, root)).toBe(true);
    }
  });

  it('appending a new leaf never rewrites an earlier one (append-only)', async () => {
    const first = (await appendLeaf(emptyLog('l'), new TextEncoder().encode('a'))).state;
    const second = (await appendLeaf(first, new TextEncoder().encode('b'))).state;
    // The original state object is unchanged (immutable), and leaf 0 is identical.
    expect(treeSize(first)).toBe(1);
    expect(treeSize(second)).toBe(2);
    expect(Array.from(second.leafHashes[0] as Uint8Array)).toEqual(
      Array.from(first.leafHashes[0] as Uint8Array),
    );
  });

  it('rejects an out-of-range proof index and an empty-log root', async () => {
    const state = (await appendLeaf(emptyLog('l'), new TextEncoder().encode('x'))).state;
    await expect(proveInclusion(state, 1)).rejects.toThrow(/out of range/);
    await expect(merkleRoot(emptyLog('l'))).rejects.toThrow(/empty/);
  });

  it('two consecutive bundles share one growing log and both verify', async () => {
    const log0 = emptyLog('licio-code-transparency');
    const release = (n: number) => ({
      bundleVersion: `0.${n}.0`,
      releaseSequence: n,
      artifactId: 'private-p2p',
    });
    const first = await produceSignedManifest({
      bundleBytes: new TextEncoder().encode('bundle one'),
      log: log0,
      release: release(1),
      signer,
    });
    const second = await produceSignedManifest({
      bundleBytes: new TextEncoder().encode('bundle two'),
      log: first.log,
      release: release(2),
      signer,
    });
    expect(first.leafIndex).toBe(0);
    expect(second.leafIndex).toBe(1);
    // The SECOND manifest's proof is against tree_size 2 and verifies.
    const verdict = await verifyUpdateManifest({
      manifest: second.manifest,
      runningBundleDigest: second.bundleDigest,
      trustedSignerPublicKeys: [signer.signerPublicKeyB64],
      logPublicKey: signer.logPublicKeyB64,
    });
    expect(verdict.trusted).toBe(true);
  });
});
