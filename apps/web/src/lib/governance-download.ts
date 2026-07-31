// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U (SPEC §16.6, §24.6) — trigger a client-side download of a governance
// model's downloadable bundle artifact. This is the accountability core: any
// member can pull the exact, content-addressed policy bundle and verify its
// digest offline. Same-origin Blob + object URL; no network beyond the
// already-fetched payload, and the temporary object URL is revoked on the next
// tick (via the shared saveBlob helper) so the click's download can begin first.
import { canonicalJson, type GovernanceModelDownloadResponse } from '@licio/shared';
import { saveBlob } from './privacy-api.js';

/**
 * The exact canonical bytes the server digested (key-sorted, no whitespace).
 *
 * Writing these bytes is what makes `sha256(downloaded file) === artifact_digest`;
 * pretty-printing (the original behaviour) produced bytes that did NOT hash to
 * the advertised digest, silently defeating the member offline-verification the
 * UI promises. The algorithm used to be INLINED here with a comment asking the
 * reader to keep it byte-identical to `@licio/governance`'s `canonicalize()`,
 * because `apps/web` may not depend on that package. It does not have to: both
 * are now `@licio/shared`'s `canonicalJson`, which `apps/web` and
 * `@licio/governance` may each depend on — so byte-identity is a fact about the
 * import graph rather than a request to a future editor.
 */
export function canonicalBundleBytes(bundle: unknown): string {
  return canonicalJson(bundle);
}

export function downloadModelBundle(model: GovernanceModelDownloadResponse): void {
  const blob = new Blob([canonicalBundleBytes(model.bundle)], { type: 'application/json' });
  saveBlob(blob, `governance-model-${model.artifact_digest.slice(0, 12)}.json`);
}
