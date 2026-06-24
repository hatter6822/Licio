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
import { ciphertextBase64Schema, privateIdSchema } from '../schemas/common.js';
import { privateEncryptedEnvelopeSchema } from '../schemas/envelope.js';
import { blockRequestSchema, blockResponseSchema, headAnnouncementSchema } from './head-sync.js';

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

/** The largest serialized MLS commit a peer will carry (a §27 DoS bound; an MLS
 *  handshake message for a small room is well under this). */
export const MAX_MLS_COMMIT_BYTES = 256 * 1024;

/**
 * §10.9 — an MLS Commit delivered to an EXISTING member so it advances to the new
 * epoch after an add/remove (the new content is sealed under the new epoch key the
 * commit installs).  `commit` is `encodeCommit(...)` base64; `epoch` is the new MLS
 * epoch the recipient should reach.  The recipient applies it (`applyCommit` →
 * `deriveEpochState` → `addEpochKeys` → `retryPending`) before its sealed content can
 * open.  The bytes are opaque to the transport (already a public MLS handshake message,
 * itself confidentiality-protected by MLS); the live channel adds DTLS on top.
 */
export const mlsCommitMessageSchema = z
  .object({
    schema: z.literal('licio.private.mls_commit.v1'),
    commit: ciphertextBase64Schema,
    epoch: z.number().int().nonnegative(),
  })
  .strict();
export type MlsCommitMessage = z.infer<typeof mlsCommitMessageSchema>;

/**
 * §15.6 — a request for the peer's retained §14.5 snapshot archive (a compacted/lagging
 * member that cannot fetch the pruned prefix op-by-op asks for the snapshot to bootstrap).
 * No fields: "serve me your latest snapshot archive".
 */
export const snapshotRequestSchema = z
  .object({ schema: z.literal('licio.private.snapshot_request.v1') })
  .strict();
export type SnapshotRequest = z.infer<typeof snapshotRequestSchema>;

/**
 * §15.6 — the §15.9 archive (sealed §14.5 snapshot + post-snapshot envelopes), base64.
 * The requester adopts it via `importArchive`, which re-verifies the in-band
 * `snapshot.commit` (the container confers no trust, §8.3).
 */
export const snapshotResponseSchema = z
  .object({
    schema: z.literal('licio.private.snapshot_response.v1'),
    archive: ciphertextBase64Schema,
  })
  .strict();
export type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;

/**
 * §15.4 — a graceful teardown signal: "I am closing this session intentionally."  The
 * recipient distinguishes a deliberate leave (do NOT reconnect) from a network drop
 * (reconnect).  No fields.
 */
export const byeMessageSchema = z.object({ schema: z.literal('licio.private.bye.v1') }).strict();
export type ByeMessage = z.infer<typeof byeMessageSchema>;

/** The §15.6/§15.7 sync message union carried on the pairwise channel. */
export const syncMessageSchema = z.discriminatedUnion('schema', [
  headAnnouncementSchema,
  opRequestSchema,
  opResponseSchema,
  mlsCommitMessageSchema,
  blockRequestSchema,
  blockResponseSchema,
  snapshotRequestSchema,
  snapshotResponseSchema,
  byeMessageSchema,
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
