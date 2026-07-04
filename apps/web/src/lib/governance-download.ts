// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U (SPEC §16.6, §24.6) — trigger a client-side download of a governance
// model's downloadable bundle artifact. This is the accountability core: any
// member can pull the exact, content-addressed policy bundle and verify its
// digest offline. Same-origin Blob + object URL; no network beyond the
// already-fetched payload, and the temporary URL is revoked immediately.
import type { GovernanceModelDownloadResponse } from '@licio/shared';

/**
 * Recursively key-sorted, whitespace-free JSON — byte-identical to the
 * `@licio/governance` `canonicalize()` the SERVER digests (apps/web cannot depend
 * on that package, so the tiny algorithm is inlined). Writing these exact bytes is
 * what makes `sha256(downloaded file) === artifact_digest`; pretty-printing (the
 * prior behaviour) produced bytes that did NOT hash to the advertised digest,
 * silently defeating the member offline-verification the UI promises.
 */
function toCanonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toCanonical);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = toCanonical(obj[key]);
  return sorted;
}

/** The exact canonical bytes the server digested (key-sorted, no whitespace). */
export function canonicalBundleBytes(bundle: unknown): string {
  return JSON.stringify(toCanonical(bundle));
}

export function downloadModelBundle(model: GovernanceModelDownloadResponse): void {
  const blob = new Blob([canonicalBundleBytes(model.bundle)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `governance-model-${model.artifact_digest.slice(0, 12)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
