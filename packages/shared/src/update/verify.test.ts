// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2a — verifier tests.  A valid manifest ACTIVATES; a tampered digest,
// a bad/untrusted signature, an absence-from-log, a forged checkpoint, and a
// stale release each LOCK with the correct typed reason.  Real WebCrypto
// Ed25519 + a real RFC 9162 inclusion proof exercise the genuine paths.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildValidManifest,
  type Ed25519KeyPair,
  generateKeyPair,
  reSignManifest,
  toBase64Url,
} from './test-helpers.js';
import { decideUpdateActivation, verifyUpdateManifest } from './verify.js';

const bundleBytes = new TextEncoder().encode('the reproducible private-mode chunk bytes');

let signer: Ed25519KeyPair;
let log: Ed25519KeyPair;

beforeAll(async () => {
  signer = await generateKeyPair();
  log = await generateKeyPair();
});

function baseInput(manifest: unknown, runningBundleDigest: string) {
  return {
    manifest,
    runningBundleDigest,
    expectedArtifactId: 'private-p2p',
    trustedSignerPublicKeys: [signer.publicKeyB64],
    logPublicKey: log.publicKeyB64,
  };
}

describe('verifyUpdateManifest — happy path', () => {
  it('a fully valid manifest is TRUSTED and ACTIVATES', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
    });
    const verdict = await verifyUpdateManifest(baseInput(manifest, runningBundleDigest));
    expect(verdict.trusted).toBe(true);
    if (!verdict.trusted) throw new Error('expected trusted');
    expect(verdict.releaseSequence).toBe(7);
    const decision = decideUpdateActivation(verdict);
    expect(decision.action).toBe('activate');
  });

  it('verifies a single-leaf log (empty proof path)', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
      otherLeaves: 0,
      leafIndex: 0,
    });
    expect(manifest.inclusion_proof.proof_hashes).toHaveLength(0);
    const verdict = await verifyUpdateManifest(baseInput(manifest, runningBundleDigest));
    expect(verdict.trusted).toBe(true);
  });
});

describe('verifyUpdateManifest — fail-closed lock reasons', () => {
  it('digest_mismatch when the running bundle differs from the manifest digest', async () => {
    const { manifest } = await buildValidManifest({ bundleBytes, signer, log });
    const otherDigest = toBase64Url(new Uint8Array(32).fill(9));
    const verdict = await verifyUpdateManifest(baseInput(manifest, otherDigest));
    expect(verdict).toEqual({ trusted: false, reason: 'digest_mismatch' });
    expect(decideUpdateActivation(verdict)).toEqual({
      action: 'lock-rooms',
      reason: 'digest_mismatch',
    });
  });

  it('signature_invalid when the maintainer signature is corrupted', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
    });
    const badSig = toBase64Url(new Uint8Array(64).fill(1));
    const verdict = await verifyUpdateManifest(
      baseInput({ ...manifest, signature: badSig }, runningBundleDigest),
    );
    expect(verdict).toEqual({ trusted: false, reason: 'signature_invalid' });
  });

  it('signature_invalid when the signer key is not in the trusted set', async () => {
    const stranger = await generateKeyPair();
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer: stranger,
      log,
    });
    // Signed validly, but by a stranger not in trustedSignerPublicKeys.
    const verdict = await verifyUpdateManifest(baseInput(manifest, runningBundleDigest));
    expect(verdict).toEqual({ trusted: false, reason: 'signature_invalid' });
  });

  it('not_in_transparency_log when the inclusion proof is tampered', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
    });
    const tampered = {
      ...manifest,
      inclusion_proof: {
        ...manifest.inclusion_proof,
        proof_hashes: [
          toBase64Url(new Uint8Array(32).fill(3)),
          ...manifest.inclusion_proof.proof_hashes.slice(1),
        ],
      },
    };
    const verdict = await verifyUpdateManifest(baseInput(tampered, runningBundleDigest));
    expect(verdict).toEqual({ trusted: false, reason: 'not_in_transparency_log' });
  });

  it('not_in_transparency_log when the checkpoint signature is forged', async () => {
    const wrongLog = await generateKeyPair();
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log: wrongLog, // checkpoint signed by the wrong log key
    });
    const verdict = await verifyUpdateManifest(baseInput(manifest, runningBundleDigest));
    expect(verdict).toEqual({ trusted: false, reason: 'not_in_transparency_log' });
  });

  it('not_in_transparency_log when the proof and checkpoint tree sizes disagree', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
    });
    const tampered = {
      ...manifest,
      inclusion_proof: {
        ...manifest.inclusion_proof,
        tree_size: manifest.checkpoint.tree_size + 1,
      },
    };
    const verdict = await verifyUpdateManifest(baseInput(tampered, runningBundleDigest));
    expect(verdict).toEqual({ trusted: false, reason: 'not_in_transparency_log' });
  });

  it('stale when the release sequence is below the last trusted sequence', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
      releaseSequence: 5,
    });
    const verdict = await verifyUpdateManifest({
      ...baseInput(manifest, runningBundleDigest),
      lastTrustedSequence: 9,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'stale' });
  });

  it('a new release at or above the last trusted sequence is NOT stale', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
      releaseSequence: 9,
    });
    const verdict = await verifyUpdateManifest({
      ...baseInput(manifest, runningBundleDigest),
      lastTrustedSequence: 9,
    });
    expect(verdict.trusted).toBe(true);
  });

  it('malformed_manifest when an unknown field is present (strict schema)', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
    });
    const verdict = await verifyUpdateManifest(
      baseInput({ ...manifest, trusted: true }, runningBundleDigest),
    );
    expect(verdict).toEqual({ trusted: false, reason: 'malformed_manifest' });
  });

  it('malformed_manifest on a non-object / garbage input', async () => {
    const verdict = await verifyUpdateManifest(baseInput('not a manifest', 'AAAA'));
    expect(verdict).toEqual({ trusted: false, reason: 'malformed_manifest' });
  });

  it('not_in_transparency_log when the log_leaf does not commit to the digest', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
    });
    // Tamper the log_leaf AND re-sign with the real maintainer key, so the signature is
    // valid and the LEAF-COMMITMENT guard (verify.ts step 5) is the DECIDING reject — not
    // signature_invalid. Without the re-sign the test would pass on the signature branch and
    // would still pass if the leaf-commitment guard were deleted.
    const tampered = await reSignManifest(signer, {
      ...manifest,
      body: { ...manifest.body, log_leaf: toBase64Url(new Uint8Array(32).fill(7)) },
    });
    const verdict = await verifyUpdateManifest(baseInput(tampered, runningBundleDigest));
    expect(verdict).toEqual({ trusted: false, reason: 'not_in_transparency_log' });
  });

  it('not_in_transparency_log when body.log_id disagrees with the checkpoint', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
    });
    // Re-signed (valid signature + matching leaf), so the body.log_id ≠ checkpoint.log_id
    // guard (verify.ts step 6) is the DECIDING reject.
    const tampered = await reSignManifest(signer, {
      ...manifest,
      body: { ...manifest.body, log_id: 'a-different-log' },
    });
    const verdict = await verifyUpdateManifest(baseInput(tampered, runningBundleDigest));
    expect(verdict).toEqual({ trusted: false, reason: 'not_in_transparency_log' });
  });

  it('artifact_mismatch when the signed body attests a different artifact', async () => {
    // A fully valid, genuinely-signed manifest for a DIFFERENT artifact must not
    // activate THIS bundle: the signer honestly attested `some-other-artifact`,
    // but the client expects `private-p2p`, so the verdict is a distinct
    // artifact_mismatch (not overloaded onto malformed_manifest) → lock-rooms.
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
      artifactId: 'some-other-artifact',
    });
    const verdict = await verifyUpdateManifest(baseInput(manifest, runningBundleDigest));
    expect(verdict).toEqual({ trusted: false, reason: 'artifact_mismatch' });
    expect(decideUpdateActivation(verdict)).toEqual({
      action: 'lock-rooms',
      reason: 'artifact_mismatch',
    });
  });

  it('malformed_manifest when the signer key is base64url-valid but not 32 bytes', async () => {
    const { manifest, runningBundleDigest } = await buildValidManifest({
      bundleBytes,
      signer,
      log,
    });
    // A schema-valid base64url string that decodes to 31 bytes: passes the schema but fails
    // the Ed25519 public-key LENGTH check (verify.ts step 2) — which fires BEFORE the
    // signer-trust/signature checks, so this is the deciding reject.
    const malformed = { ...manifest, signer_public_key: toBase64Url(new Uint8Array(31).fill(1)) };
    const verdict = await verifyUpdateManifest(baseInput(malformed, runningBundleDigest));
    expect(verdict).toEqual({ trusted: false, reason: 'malformed_manifest' });
  });
});
