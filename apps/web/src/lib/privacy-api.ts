// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed client flows for the WS-D.2 privacy-control surface (/v1/privacy/*):
// DSAR export (request → poll → step-up-gated download), attention-history
// deletion, and account deletion with its 30-day grace window.  These wire the
// privacy page's controls to the REAL endpoints — §19.3's promise is that the
// controls take effect, not placebo toggles.  Step-up-gated calls surface
// StepUpRequiredError so the UI can satisfy the challenge and retry.
import {
  type AttentionDeleteResult,
  attentionDeleteResultSchema,
  type DeletionStatus,
  deletionStatusSchema,
  type ExportJobStatus,
  exportJobStatusSchema,
} from '@licio/shared';
import { ApiClientError, client, parseResponse } from './api.js';
import { parseWithStepUp } from './auth-api.js';

// --- DSAR export (WS-D.2.2) ----------------------------------------------------

/** Request an export (idempotent: an active job is returned instead of a new one). */
export async function requestExport(): Promise<ExportJobStatus> {
  const res = await client.v1.privacy.export.$post();
  return parseResponse(res, exportJobStatusSchema);
}

export async function fetchExportStatus(jobId: string): Promise<ExportJobStatus> {
  const res = await client.v1.privacy.export[':jobId'].$get({ param: { jobId } });
  return parseResponse(res, exportJobStatusSchema);
}

/**
 * Download a completed archive (session + fresh step-up + the signed token from
 * the status response).  Resolves to the archive blob; the caller saves it.
 * The decrypted archive is a concentrated PII bundle: it goes straight to a
 * file, never into application state.
 */
export async function downloadExport(jobId: string, token: string): Promise<Blob> {
  const res = await client.v1.privacy.export[':jobId'].download.$get({
    param: { jobId },
    query: { t: token },
  });
  if (!res.ok) {
    // Reuse the step-up/typed-error translation; the schema is never reached.
    await parseWithStepUp(res, exportJobStatusSchema);
    throw new ApiClientError('invalid_response', 'Unexpected download response');
  }
  return res.blob();
}

/** Save a downloaded archive via a transient object URL. */
export function saveBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke on the next tick so the click's navigation can begin first.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// --- Attention-history deletion (WS-D.2.3) ----------------------------------------

export async function deleteAttentionHistory(
  mode: 'delete' | 'reset',
): Promise<AttentionDeleteResult> {
  const res = await client.v1.privacy.attention.delete.$post({ json: { mode } });
  return parseResponse(res, attentionDeleteResultSchema);
}

// --- Account deletion (WS-D.2.4) -----------------------------------------------------

/**
 * Request account deletion (step-up protected).  On success the server revokes
 * EVERY session including this one — the caller must clear local auth state.
 */
export async function requestAccountDeletion(): Promise<DeletionStatus> {
  const res = await client.v1.privacy['delete-account'].$post();
  return parseWithStepUp(res, deletionStatusSchema);
}

export async function fetchDeletionStatus(): Promise<DeletionStatus> {
  const res = await client.v1.privacy['delete-account'].status.$get();
  return parseResponse(res, deletionStatusSchema);
}

/**
 * Cancel a pending deletion: with the emailed single-use token (works without a
 * session), or with the current session (the grace-period re-login path).
 */
export async function cancelAccountDeletion(token?: string): Promise<DeletionStatus> {
  const res = await client.v1.privacy['delete-account'].cancel.$post({
    json: token ? { token } : {},
  });
  return parseResponse(res, deletionStatusSchema);
}
