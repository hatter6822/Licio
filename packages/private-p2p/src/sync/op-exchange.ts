// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.4 — the §15.7 op-exchange wire messages (PRIVATE_SPEC §15.6/§15.7).  The
// head announcement (head-sync.ts) plus this request/response pair are the three
// messages a live carrier exchanges over the post-handshake pairwise channel to
// reconcile two engines' accepted-op DAGs:
//
//   1. `head_announcement` — "here are my frontier heads" (head-sync.ts).
//   2. `op_request`        — "send me these op ids" (the wanted heads, then their
//                            still-missing ancestors via `engine.missingDependencies`).
//   3. `op_response`       — "here are the encrypted envelopes for those ops".
//
// Every served envelope is run through the requester's OWN `engine.ingest` (which
// re-runs §14.2 stage-1 `openOp` + the structural pre-pass): the wire confers NO
// trust (§8.3).  The messages are canonical-DAG-CBOR-encoded (the same deterministic
// profile the rest of the private plane uses), strict-schema-validated on decode, and
// bounded for §27 DoS.

import { z } from 'zod';
import { type CanonicalValue, canonical, decodeCanonical } from '../crypto/canonical.js';
import { privateIdSchema } from '../schemas/common.js';
import { privateEncryptedEnvelopeSchema } from '../schemas/envelope.js';
import { headAnnouncementSchema } from './head-sync.js';

/** The most op ids one §15.7 request may ask for (a DoS bound, like the head cap). */
export const MAX_OP_IDS_PER_REQUEST = 4_096;
/** The most envelopes one §15.7 response may carry. */
export const MAX_ENVELOPES_PER_RESPONSE = 4_096;

export const opRequestSchema = z
  .object({
    schema: z.literal('licio.private.op_request.v1'),
    op_ids: z.array(privateIdSchema).min(1).max(MAX_OP_IDS_PER_REQUEST),
  })
  .strict();
export type OpRequest = z.infer<typeof opRequestSchema>;

export const opResponseSchema = z
  .object({
    schema: z.literal('licio.private.op_response.v1'),
    envelopes: z.array(privateEncryptedEnvelopeSchema).max(MAX_ENVELOPES_PER_RESPONSE),
  })
  .strict();
export type OpResponse = z.infer<typeof opResponseSchema>;

/** The §15.6/§15.7 sync message union carried on the pairwise channel. */
export const syncMessageSchema = z.discriminatedUnion('schema', [
  headAnnouncementSchema,
  opRequestSchema,
  opResponseSchema,
]);
export type SyncMessage = z.infer<typeof syncMessageSchema>;

/** Canonical-encode a sync message for the wire (deterministic, signable bytes). */
export function encodeSyncMessage(message: SyncMessage): Uint8Array {
  return canonical(syncMessageSchema.parse(message) as CanonicalValue);
}

/** Decode + strict-validate a sync message fail-closed (any malformed frame throws). */
export function decodeSyncMessage(bytes: Uint8Array): SyncMessage {
  return syncMessageSchema.parse(decodeCanonical(bytes));
}
