// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.5 / WS-S.10.2b — the §20.6 lock UI guard: it renders the children only
// on a TRUSTED verdict, the verbatim §20.6 lock copy on an untrusted verdict,
// and a loading placeholder while checking — and passes axe.  Real WebCrypto +
// a real RFC 9162 proof + a mocked same-origin fetch drive the genuine gate.

import {
  canonicalCheckpointBody,
  canonicalManifestBody,
  leafHash,
  nodeHash,
  PRIVATE_BUNDLE_LOCK_MESSAGE,
  sha256Concat,
  type UpdateManifest,
} from '@licio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import type { AssertTrustedDeps } from '../../update/index.js';
import { resetPrivateBundleGate } from '../../update/index.js';
import { PrivateBundleGuard } from './PrivateBundleGuard.js';

const LOG_LEAF_DOMAIN = new TextEncoder().encode('licio-update-v1:');
const BUNDLE_BYTES = new TextEncoder().encode('the running private-mode chunk bytes');
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
async function trustedDeps(): Promise<AssertTrustedDeps> {
  const signer = await genKeyPair();
  const log = await genKeyPair();
  const digest = await sha256Concat(BUNDLE_BYTES);
  const logLeaf = await sha256Concat(LOG_LEAF_DOMAIN, digest);
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
  const cp = { log_id: 'licio-code-transparency', tree_size: 2, merkle_root: toBase64Url(root) };
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
      ...cp,
      signature: await sign(log.privateKey, canonicalCheckpointBody({ ...cp, signature: '' })),
    },
  };
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('private-p2p-')) return new Response(BUNDLE_BYTES, { status: 200 });
    if (url.includes('update-manifest.json'))
      return new Response(JSON.stringify(manifest), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    config: { trustedSignerPublicKeys: [signer.b64], logPublicKey: log.b64 },
    fetchImpl,
    resolveBundleUrl: () => BUNDLE_URL,
  };
}

afterEach(() => resetPrivateBundleGate());

describe('PrivateBundleGuard', () => {
  it('renders children when the bundle verdict is TRUSTED', async () => {
    resetPrivateBundleGate();
    const deps = await trustedDeps();
    render(
      <PrivateBundleGuard deps={deps}>
        <p>secret room content</p>
      </PrivateBundleGuard>,
    );
    await waitFor(() => expect(screen.getByText('secret room content')).toBeInTheDocument());
  });

  it('LOCKS with the verbatim §20.6 copy on an untrusted verdict and hides children', async () => {
    resetPrivateBundleGate();
    // An empty signer set ⇒ every manifest is signature_invalid ⇒ lock.
    const deps: AssertTrustedDeps = {
      config: { trustedSignerPublicKeys: [], logPublicKey: '' },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      resolveBundleUrl: () => BUNDLE_URL,
    };
    const { container } = render(
      <PrivateBundleGuard deps={deps}>
        <p>secret room content</p>
      </PrivateBundleGuard>,
    );
    await waitFor(() => expect(screen.getByText(PRIVATE_BUNDLE_LOCK_MESSAGE)).toBeInTheDocument());
    expect(screen.queryByText('secret room content')).not.toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('renders children unguarded when disabled (public surface)', () => {
    resetPrivateBundleGate();
    render(
      <PrivateBundleGuard enabled={false}>
        <p>public content</p>
      </PrivateBundleGuard>,
    );
    expect(screen.getByText('public content')).toBeInTheDocument();
  });
});
