// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U (SPEC §16.6, §24.6) — trigger a client-side download of a governance
// model's downloadable bundle artifact. This is the accountability core: any
// member can pull the exact, content-addressed policy bundle and verify its
// digest offline. Same-origin Blob + object URL; no network beyond the
// already-fetched payload, and the temporary URL is revoked immediately.
import type { GovernanceModelDownloadResponse } from '@licio/shared';

export function downloadModelBundle(model: GovernanceModelDownloadResponse): void {
  const blob = new Blob([JSON.stringify(model.bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `governance-model-${model.artifact_digest.slice(0, 12)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
