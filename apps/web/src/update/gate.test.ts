// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2a/b — client gate tests: a trusted bundle ⇒ the gate unlocks; a
// tampered/absent/unsigned bundle ⇒ the gate LOCKS with the §20.6 copy and
// `isPrivateBundleLocked()` is true.  Real WebCrypto Ed25519 + a real RFC 9162
// inclusion proof + a mocked same-origin fetch exercise the genuine path.

import {
  canonicalCheckpointBody,
  canonicalManifestBody,
  leafHash,
  nodeHash,
  PRIVATE_BUNDLE_LOCK_MESSAGE,
  sha256Concat,
  type UpdateManifest,
} from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpdateChannelConfig } from './config.js';
import {
  assertPrivateBundleTrusted,
  isPrivateBundleLocked,
  resetPrivateBundleGate,
} from './gate.js';

const LOG_LEAF_DOMAIN = new TextEncoder().encode('licio-update-v1:');
const BUNDLE_BYTES = new TextEncoder().encode('the running private-mode chunk bytes');
// Relative ⇒ same-origin under any jsdom base (default http://localhost/).
const BUNDLE_URL = '/assets/private-p2p-deadbeef.js';

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function genKeyPair() {
  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, b64: toBase64Url(raw) };
}

async function sign(privateKey: CryptoKey, msg: Uint8Array): Promise<string> {
  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, msg.slice().buffer)),
  );
}

interface Built {
  manifest: UpdateManifest;
  signerB64: string;
  logB64: string;
}

async function buildManifest(): Promise<Built> {
  const signer = await genKeyPair();
  const log = await genKeyPair();
  const digest = await sha256Concat(BUNDLE_BYTES);
  const logLeaf = await sha256Concat(LOG_LEAF_DOMAIN, digest);
  // Two-leaf tree, our leaf at index 1.
  const other = await sha256Concat(new TextEncoder().encode('other'));
  const leafHashes = [await leafHash(other), await leafHash(logLeaf)];
  const root = await nodeHash(leafHashes[0] as Uint8Array, leafHashes[1] as Uint8Array);
  const body = {
    manifest_version: 1 as const,
    bundle_version: '0.1.0',
    release_sequence: 3,
    artifact_id: 'private-p2p',
    bundle_digest: toBase64Url(digest),
    log_id: 'licio-code-transparency',
    log_leaf: toBase64Url(logLeaf),
  };
  const checkpointBase = {
    log_id: 'licio-code-transparency',
    tree_size: 2,
    merkle_root: toBase64Url(root),
  };
  const manifest: UpdateManifest = {
    body,
    signature: await sign(signer.privateKey, canonicalManifestBody(body)),
    signer_public_key: signer.b64,
    inclusion_proof: {
      leaf_index: 1,
      tree_size: 2,
      proof_hashes: [toBase64Url(leafHashes[0] as Uint8Array)],
    },
    checkpoint: {
      ...checkpointBase,
      signature: await sign(
        log.privateKey,
        canonicalCheckpointBody({ ...checkpointBase, signature: '' }),
      ),
    },
  };
  return { manifest, signerB64: signer.b64, logB64: log.b64 };
}

function makeFetch(manifest: unknown): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('private-p2p-')) {
      return new Response(BUNDLE_BYTES, { status: 200 });
    }
    if (url.includes('update-manifest.json')) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let built: Built;
let config: UpdateChannelConfig;

beforeEach(async () => {
  resetPrivateBundleGate();
  built = await buildManifest();
  config = { trustedSignerPublicKeys: [built.signerB64], logPublicKey: built.logB64 };
});

afterEach(() => {
  resetPrivateBundleGate();
});

describe('assertPrivateBundleTrusted (client gate)', () => {
  it('UNLOCKS on a fully trusted bundle', async () => {
    const verdict = await assertPrivateBundleTrusted({
      config,
      fetchImpl: makeFetch(built.manifest),
      resolveBundleUrl: () => BUNDLE_URL,
    });
    expect(verdict.trusted).toBe(true);
    expect(isPrivateBundleLocked()).toBe(false);
  });

  it('LOCKS with the §20.6 copy when the manifest digest does not match the bundle', async () => {
    // Serve different bundle bytes than the manifest committed.
    const wrongFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('private-p2p-')) return new Response(new TextEncoder().encode('SWAPPED'));
      return new Response(JSON.stringify(built.manifest), { status: 200 });
    }) as typeof fetch;
    const verdict = await assertPrivateBundleTrusted({
      config,
      fetchImpl: wrongFetch,
      resolveBundleUrl: () => BUNDLE_URL,
    });
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error('expected lock');
    expect(verdict.reason).toBe('digest_mismatch');
    expect(isPrivateBundleLocked()).toBe(true);
    // The published gate state carries the verbatim §20.6 message.
    const { privateBundleGateState } = await import('./gate.js');
    expect(privateBundleGateState().message).toBe(PRIVATE_BUNDLE_LOCK_MESSAGE);
  });

  it('LOCKS when the signer is not in the trusted set', async () => {
    const verdict = await assertPrivateBundleTrusted({
      config: { trustedSignerPublicKeys: [], logPublicKey: built.logB64 },
      fetchImpl: makeFetch(built.manifest),
      resolveBundleUrl: () => BUNDLE_URL,
    });
    expect(verdict.trusted).toBe(false);
    if (verdict.trusted) throw new Error('expected lock');
    expect(verdict.reason).toBe('signature_invalid');
  });

  it('LOCKS (not_in_transparency_log) on a manifest fetch failure (fail-closed)', async () => {
    const failingFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('private-p2p-')) return new Response(BUNDLE_BYTES, { status: 200 });
      return new Response('gone', { status: 500 });
    }) as typeof fetch;
    const verdict = await assertPrivateBundleTrusted({
      config,
      fetchImpl: failingFetch,
      resolveBundleUrl: () => BUNDLE_URL,
    });
    expect(verdict.trusted).toBe(false);
    expect(isPrivateBundleLocked()).toBe(true);
  });

  it('LOCKS when the running bundle URL cannot be resolved', async () => {
    const verdict = await assertPrivateBundleTrusted({
      config,
      fetchImpl: makeFetch(built.manifest),
      resolveBundleUrl: () => undefined,
    });
    expect(verdict.trusted).toBe(false);
    expect(isPrivateBundleLocked()).toBe(true);
  });
});
