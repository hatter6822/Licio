// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — `gatedApplyUpdate` ARMS the SW pin: a device with NO private
// rooms keeps the fast public path (a bare SKIP_WAITING); a private-room device
// posts the GATED + VERIFIED flags ONLY on a trusted verdict; on a lock it does
// NOT activate and runs `onLocked`.  Real WebCrypto Ed25519 + a real RFC 9162
// inclusion proof + a mocked same-origin fetch exercise the genuine path.

import {
  canonicalCheckpointBody,
  canonicalManifestBody,
  leafHash,
  nodeHash,
  sha256Concat,
  type UpdateManifest,
} from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toBase64Url } from './bundle-digest.js';
import type { UpdateChannelConfig } from './config.js';
import { resetPrivateBundleGate } from './gate.js';
import { deviceHasPrivateRooms, gatedApplyUpdate } from './install-sw-pinning.js';

const LOG_LEAF_DOMAIN = new TextEncoder().encode('licio-update-v1:');
const BUNDLE_BYTES = new TextEncoder().encode('the running private-mode chunk bytes');
const BUNDLE_URL = '/assets/private-p2p-deadbeef.js';

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

async function buildManifest() {
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
    release_sequence: 5,
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

// The latest index.html the SW gate fetches to discover the PENDING bundle URL.
const INDEX_HTML = `<!doctype html><html><head><link rel="modulepreload" href="${BUNDLE_URL}"></head><body></body></html>`;

function makeFetch(manifest: unknown): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('index.html'))
      return new Response(INDEX_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.includes('private-p2p-')) return new Response(BUNDLE_BYTES, { status: 200 });
    if (url.includes('update-manifest.json'))
      return new Response(JSON.stringify(manifest), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

interface FakeWorker {
  readonly posts: Array<Record<string, unknown>>;
  postMessage: (m: Record<string, unknown>) => void;
}
function fakeWorker(): FakeWorker {
  const posts: Array<Record<string, unknown>> = [];
  return { posts, postMessage: (m) => posts.push(m) };
}

let built: Awaited<ReturnType<typeof buildManifest>>;
let config: UpdateChannelConfig;

beforeEach(async () => {
  resetPrivateBundleGate();
  built = await buildManifest();
  config = { trustedSignerPublicKeys: [built.signerB64], logPublicKey: built.logB64 };
});
afterEach(() => resetPrivateBundleGate());

describe('gatedApplyUpdate', () => {
  it('posts a bare SKIP_WAITING (no gating) when the device has NO private rooms', async () => {
    const worker = fakeWorker();
    await gatedApplyUpdate(worker as unknown as ServiceWorker, {
      hasPrivateRooms: async () => false,
      deps: { config, fetchImpl: makeFetch(built.manifest), resolveBundleUrl: () => BUNDLE_URL },
    });
    expect(worker.posts).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('posts the GATED + VERIFIED flags on a TRUSTED verdict for a private-room device', async () => {
    const worker = fakeWorker();
    let locked = false;
    await gatedApplyUpdate(worker as unknown as ServiceWorker, {
      hasPrivateRooms: async () => true,
      onLocked: () => {
        locked = true;
      },
      deps: { config, fetchImpl: makeFetch(built.manifest), resolveBundleUrl: () => BUNDLE_URL },
    });
    expect(locked).toBe(false);
    expect(worker.posts).toEqual([
      { type: 'SKIP_WAITING', privateBundleGated: true, privateBundleVerified: true },
    ]);
  });

  it('does NOT activate and runs onLocked on an UNTRUSTED verdict (digest mismatch)', async () => {
    const worker = fakeWorker();
    let locked = false;
    const swappedFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      // Serve the real index.html so the PENDING discovery finds the chunk — but the chunk's
      // bytes are SWAPPED, so the pending digest no longer matches the signed manifest.
      if (url.includes('index.html'))
        return new Response(INDEX_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      if (url.includes('private-p2p-')) return new Response(new TextEncoder().encode('SWAPPED'));
      return new Response(JSON.stringify(built.manifest), { status: 200 });
    }) as typeof fetch;
    await gatedApplyUpdate(worker as unknown as ServiceWorker, {
      hasPrivateRooms: async () => true,
      onLocked: () => {
        locked = true;
      },
      deps: { config, fetchImpl: swappedFetch, resolveBundleUrl: () => BUNDLE_URL },
    });
    expect(locked).toBe(true);
    expect(worker.posts).toEqual([]); // the verified flag is NEVER posted on a lock
  });
});

describe('deviceHasPrivateRooms (fail-closed probe)', () => {
  const realIdb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const setIdb = (value: unknown): void => {
    Object.defineProperty(globalThis, 'indexedDB', { value, configurable: true, writable: true });
  };
  afterEach(() => {
    if (realIdb) Object.defineProperty(globalThis, 'indexedDB', realIdb);
  });

  it('fails CLOSED (true) when the platform cannot enumerate databases', async () => {
    setIdb({}); // no databases() method
    expect(await deviceHasPrivateRooms()).toBe(true);
  });

  it('fails CLOSED (true) when databases() throws', async () => {
    setIdb({
      databases: () => {
        throw new Error('enumeration blocked');
      },
    });
    expect(await deviceHasPrivateRooms()).toBe(true);
  });

  it('returns true when the isolated private-rooms DB is present', async () => {
    setIdb({ databases: () => Promise.resolve([{ name: 'licio_private_p2p' }]) });
    expect(await deviceHasPrivateRooms()).toBe(true);
  });

  it('returns false ONLY when enumeration succeeds and no private-rooms DB exists', async () => {
    setIdb({ databases: () => Promise.resolve([{ name: 'licio' }, { name: 'licio-keys' }]) });
    expect(await deviceHasPrivateRooms()).toBe(false);
  });
});
