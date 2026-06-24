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
  cache: RequestCache = 'force-cache',
): Promise<string> {
  const url = new URL(bundleUrl, location.href);
  if (url.origin !== location.origin) {
    throw new Error('refusing to hash a cross-origin private-mode bundle');
  }
  const res = await fetchImpl(url.href, { credentials: 'same-origin', cache });
  if (!res.ok) throw new Error(`private-mode bundle fetch failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('private-mode bundle is empty');
  const digest = await sha256Concat(bytes);
  return toBase64Url(digest);
}

/**
 * Discover the PENDING build's private-mode chunk URL from a fetched `index.html`.  The running
 * document's DOM only references the CURRENT chunk; to verify the build a WAITING service worker
 * would activate, the SW gate fetches the latest `index.html` (the build the server serves now)
 * and parses its private-mode chunk reference.  Same-origin only; fail-closed (`undefined`).
 */
export function discoverPrivateBundleUrlInHtml(html: string): string | undefined {
  const needle = `${PRIVATE_BUNDLE_ARTIFACT_ID}-`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of Array.from(
    doc.querySelectorAll('link[rel="modulepreload"][href], script[type="module"][src]'),
  )) {
    const raw = el.getAttribute('href') ?? el.getAttribute('src');
    if (!raw) continue;
    try {
      // Resolve against the ORIGIN (the build emits absolute `/assets/...` paths); a fetched
      // document has no live base, so we never rely on the parsed doc's baseURI.
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin) continue; // same-origin only
      const file = url.pathname.split('/').pop() ?? '';
      if (file.startsWith(needle) && file.endsWith('.js')) return url.href;
    } catch {
      // skip malformed
    }
  }
  return undefined;
}

/**
 * Fetch the latest `index.html` (no-store ⇒ the server's current build, i.e. what the waiting
 * worker serves) and return the PENDING private-mode chunk URL.  Fail-closed: a non-OK fetch
 * returns `undefined`, which the gate turns into a lock.
 */
export async function fetchPendingPrivateBundleUrl(
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const res = await fetchImpl('/index.html', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) return undefined;
  return discoverPrivateBundleUrlInHtml(await res.text());
}

export { toBase64Url };
