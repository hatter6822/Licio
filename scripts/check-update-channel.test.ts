// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — the `check:update-channel` gate, proven to BITE.  The real
// source tree passes; an injected reader that drops a required marker (or
// smuggles `eval` into the worker) fails with the right violation.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emptyLog,
  type ManifestSigner,
  produceSignedManifest,
} from '../packages/shared/src/update/producer.js';
import {
  type ProducedArtifactIO,
  REQUIRED_FILES,
  runUpdateChannelGate,
  verifyProducedManifest,
} from './check-update-channel.js';

const ROOT = resolve(import.meta.dirname, '..');
const realRead = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

const BUNDLE_BYTES = new TextEncoder().encode('the built private-mode chunk bytes');

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function makeSigner(): Promise<{
  signer: ManifestSigner;
  signerPublicKeyB64: string;
  logPublicKeyB64: string;
}> {
  const signerPair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const logPair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const signerPub = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey('raw', signerPair.publicKey)),
  );
  const logPub = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey('raw', logPair.publicKey)),
  );
  const sign =
    (key: CryptoKey) =>
    async (m: Uint8Array): Promise<Uint8Array> =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', key, m.slice().buffer));
  return {
    signer: {
      signerPublicKeyB64: signerPub,
      signManifest: sign(signerPair.privateKey),
      signCheckpoint: sign(logPair.privateKey),
      toBase64Url,
    },
    signerPublicKeyB64: signerPub,
    logPublicKeyB64: logPub,
  };
}

/** A produced-artifact IO over an in-memory produced manifest. */
async function producedIO(): Promise<{ io: ProducedArtifactIO; logPublicKeyB64: string }> {
  const { signer, signerPublicKeyB64, logPublicKeyB64 } = await makeSigner();
  const produced = await produceSignedManifest({
    bundleBytes: BUNDLE_BYTES,
    log: emptyLog('licio-code-transparency'),
    release: { bundleVersion: '0.1.0', releaseSequence: 1, artifactId: 'private-p2p' },
    signer,
  });
  const io: ProducedArtifactIO = {
    bundleBytes: () => BUNDLE_BYTES,
    manifest: () => produced.manifest,
    keys: () => ({ signerPublicKeys: [signerPublicKeyB64], logPublicKey: logPublicKeyB64 }),
  };
  return { io, logPublicKeyB64 };
}

describe('check:update-channel', () => {
  it('passes over the real source tree (the wiring is present)', () => {
    expect(runUpdateChannelGate(realRead)).toEqual([]);
  });

  it('BITES when a required verify-before-activate marker is removed', () => {
    const target = 'packages/shared/src/update/verify.ts';
    const tamperedRead = (rel: string): string => {
      const src = realRead(rel);
      if (rel === target) return src.replace(/verifyInclusion/g, 'XXX');
      return src;
    };
    const violations = runUpdateChannelGate(tamperedRead);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.file === target && v.detail.includes('verifyInclusion'))).toBe(
      true,
    );
  });

  it('BITES when the client gate loses the §20.6 lock copy', () => {
    const target = 'apps/web/src/update/gate.ts';
    const tamperedRead = (rel: string): string => {
      const src = realRead(rel);
      if (rel === target) return src.replace(/PRIVATE_BUNDLE_LOCK_MESSAGE/g, 'SILENT_PASS');
      return src;
    };
    const violations = runUpdateChannelGate(tamperedRead);
    expect(
      violations.some((v) => v.file === target && v.detail.includes('PRIVATE_BUNDLE_LOCK_MESSAGE')),
    ).toBe(true);
  });

  it('BITES when the service worker smuggles eval()', () => {
    const target = 'apps/web/public/sw-push.js';
    const tamperedRead = (rel: string): string => {
      const src = realRead(rel);
      if (rel === target) return `${src}\neval(self.location.search);\n`;
      return src;
    };
    const violations = runUpdateChannelGate(tamperedRead);
    expect(violations.some((v) => v.file === target && v.detail === 'sw eval()')).toBe(true);
  });

  it('BITES when a required file is missing entirely', () => {
    const target = REQUIRED_FILES[0]?.file;
    const tamperedRead = (rel: string): string => {
      if (rel === target) throw new Error('ENOENT');
      return realRead(rel);
    };
    const violations = runUpdateChannelGate(tamperedRead);
    expect(violations.some((v) => v.file === target && v.detail.includes('not found'))).toBe(true);
  });

  it('requires the producer + log + build-script + lock-UI files', () => {
    const required = REQUIRED_FILES.map((r) => r.file);
    expect(required).toContain('packages/shared/src/update/produce.ts');
    expect(required).toContain('packages/shared/src/update/log.ts');
    expect(required).toContain('scripts/build-update-manifest.ts');
    expect(required).toContain('apps/web/src/components/update/PrivateBundleGuard.tsx');
    expect(required).toContain('apps/web/src/update/anti-rollback.ts');
  });
});

describe('verifyProducedManifest (the produced + signed + logged artifact)', () => {
  it('accepts a real produced manifest (trusted)', async () => {
    const { io } = await producedIO();
    expect(await verifyProducedManifest(io)).toEqual([]);
  });

  it('BITES when the manifest is missing', async () => {
    const { io } = await producedIO();
    const missing: ProducedArtifactIO = { ...io, manifest: () => undefined };
    const v = await verifyProducedManifest(missing);
    expect(v.some((x) => x.detail.includes('no produced manifest'))).toBe(true);
  });

  it('BITES when the keys sidecar is missing', async () => {
    const { io } = await producedIO();
    const missing: ProducedArtifactIO = { ...io, keys: () => undefined };
    const v = await verifyProducedManifest(missing);
    expect(v.some((x) => x.detail.includes('public-keys sidecar'))).toBe(true);
  });

  it('BITES when the built chunk is absent', async () => {
    const { io } = await producedIO();
    const missing: ProducedArtifactIO = { ...io, bundleBytes: () => undefined };
    const v = await verifyProducedManifest(missing);
    expect(v.some((x) => x.detail.includes('private-p2p-*.js chunk'))).toBe(true);
  });

  it('BITES when the served chunk does not match the attested digest (swap)', async () => {
    const { io } = await producedIO();
    const swapped: ProducedArtifactIO = {
      ...io,
      bundleBytes: () => new TextEncoder().encode('SWAPPED bytes after attestation'),
    };
    const v = await verifyProducedManifest(swapped);
    expect(
      v.some((x) => x.detail.includes('NOT trusted') && x.detail.includes('digest_mismatch')),
    ).toBe(true);
  });

  it('BITES when the manifest signature is forged (signer not in the sidecar)', async () => {
    const { io } = await producedIO();
    const forged: ProducedArtifactIO = {
      ...io,
      keys: () => ({ signerPublicKeys: ['AAAA'], logPublicKey: io.keys()?.logPublicKey ?? '' }),
    };
    const v = await verifyProducedManifest(forged);
    expect(v.some((x) => x.detail.includes('NOT trusted'))).toBe(true);
  });
});
