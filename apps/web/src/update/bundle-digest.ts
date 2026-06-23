// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2a — compute the SHA-256 digest of the RUNNING private-mode bundle
// bytes (PRIVATE_SPEC §20.6; WS-O.3.2e "fetch-and-hash a chunk's bytes ... before
// importing or executing it").  A chunk cannot verify itself, so the trusted app
// bootstrap fetches the chunk's bytes SAME-ORIGIN, hashes them, and the verifier
// (`verifyUpdateManifest`) compares that hash to the signed manifest digest.
// The digest is computed over the EXACT bytes that would be imported — so a
// server that swaps the chunk after attestation is caught at the digest check.
//
// Resolution is fail-closed: an unresolvable chunk URL or a non-OK fetch throws,
// which the gate turns into a lock (a digest it cannot compute is never trusted).

import { sha256Concat } from '@licio/shared';
import { PRIVATE_BUNDLE_ARTIFACT_ID } from './config.js';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Discover the URL of the running private-mode chunk from the document's loaded
 * module scripts / preloaded modules.  The build emits the chunk as
 * `assets/private-p2p-<hash>.js` (vite.config.ts manualChunks).  Same-origin
 * only; returns `undefined` if it cannot be found (the caller fails closed).
 */
export function discoverPrivateBundleUrl(doc: Document = document): string | undefined {
  const needle = `${PRIVATE_BUNDLE_ARTIFACT_ID}-`;
  const candidates: string[] = [];
  for (const link of Array.from(doc.querySelectorAll('link[rel="modulepreload"]'))) {
    const href = (link as HTMLLinkElement).href;
    if (href) candidates.push(href);
  }
  for (const script of Array.from(doc.querySelectorAll('script[type="module"][src]'))) {
    const src = (script as HTMLScriptElement).src;
    if (src) candidates.push(src);
  }
  for (const raw of candidates) {
    try {
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) continue; // same-origin only
      const file = url.pathname.split('/').pop() ?? '';
      if (file.startsWith(needle) && file.endsWith('.js')) return url.href;
    } catch {
      // skip malformed
    }
  }
  return undefined;
}

/** Fetch the running chunk bytes (same-origin) and return its SHA-256 (base64url). */
export async function computeRunningBundleDigest(
  bundleUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = new URL(bundleUrl, location.href);
  if (url.origin !== location.origin) {
    throw new Error('refusing to hash a cross-origin private-mode bundle');
  }
  const res = await fetchImpl(url.href, { credentials: 'same-origin', cache: 'force-cache' });
  if (!res.ok) throw new Error(`private-mode bundle fetch failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('private-mode bundle is empty');
  const digest = await sha256Concat(bytes);
  return toBase64Url(digest);
}

export { toBase64Url };
