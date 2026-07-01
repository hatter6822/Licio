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
import {
  type CanonicalDecodeLimits,
  type CanonicalValue,
  canonical,
  DEFAULT_CANONICAL_DECODE_LIMITS,
  decodeCanonical,
} from '../crypto/canonical.js';
import { ciphertextBase64Schema, privateIdSchema } from '../schemas/common.js';
import {
  type PrivateEncryptedEnvelope,
  privateEncryptedEnvelopeSchema,
} from '../schemas/envelope.js';
import { blockRequestSchema, blockResponseSchema, headAnnouncementSchema } from './head-sync.js';

/**
 * The §27 per-message DoS ceiling on ONE decoded sync frame (16 MiB) — larger than the default
 * canonical cap (4 MiB) because a full `op_response`/`block_response` (media chunks) legitimately
 * exceeds 4 MiB after base64 expansion, and the carrier now FRAGMENTS a message this large across
 * datachannel messages (`PrivateFragmentReassembler`, whose reassembly cap matches this).  Bounding
 * the two together means any message that reassembles also decodes — and vice versa — so a fully
 * budgeted response is never SILENTLY dropped at decode (the media-sync stall PRIV-SYNC-FRAGMENT
 * closes), while a genuinely oversized frame still fails closed.
 */
export const MAX_SYNC_MESSAGE_BYTES = 16 * 1024 * 1024;

const SYNC_DECODE_LIMITS: CanonicalDecodeLimits = {
  ...DEFAULT_CANONICAL_DECODE_LIMITS,
  maxBytes: MAX_SYNC_MESSAGE_BYTES,
};

/**
 * The largest §14.5 snapshot archive (raw bytes) the LIVE carrier will serve in one
 * `snapshot_response`: bounded so the whole base64-encoded sync message stays within
 * {@link MAX_SYNC_MESSAGE_BYTES} (base64 expands 4/3, plus framing).  A room whose snapshot exceeds
 * this bootstraps a lagging member via the §15.9 OFFLINE CAR archive path instead (whose own decode
 * budget is larger); `onSnapshotRequest` declines gracefully rather than emitting an unsendable frame.
 */
export const MAX_LIVE_SNAPSHOT_ARCHIVE_BYTES = 11 * 1024 * 1024;

/** base64url of a live snapshot archive, bounded so the sync message fits {@link MAX_SYNC_MESSAGE_BYTES}. */
const liveSnapshotArchiveSchema = z
  .string()
  .min(1)
  .max(Math.ceil((MAX_LIVE_SNAPSHOT_ARCHIVE_BYTES * 4) / 3))
  .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url (no padding)');

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

/** The fixed non-envelope framing of an encoded `op_response` — the CBOR map header, the `schema`
 *  key + literal, the `envelopes` key, and the array header — plus a safety margin, reserved from the
 *  frame budget so a chunk's FULL encoded size never exceeds {@link MAX_SYNC_MESSAGE_BYTES}. */
const OP_RESPONSE_FRAME_OVERHEAD = 256;

/**
 * Split served op envelopes into `op_response` batches, each of which encodes within the §27 sync
 * frame cap ({@link MAX_SYNC_MESSAGE_BYTES}) AND the {@link MAX_ENVELOPES_PER_RESPONSE} count cap — so
 * a large retained-op set (many §25.4-padded envelopes, a normal request in a big room) is delivered
 * across SEVERAL frames instead of one oversized frame that `fragmentPrivateMessage`/decode would drop,
 * stalling convergence (PRIV-OP-RESPONSE-FRAME-BOUND).  Canonical CBOR encodes each envelope
 * independently, so the sum of per-envelope encoded sizes plus the fixed framing overhead equals the
 * encoded response size (no O(n²) re-encoding).  Returns a single EMPTY batch for no envelopes
 * (preserving the empty-response "peer may need a §14.5 snapshot" signal), and never splits below one
 * envelope per batch (a single padded envelope is far under the cap).  ALL served envelopes are emitted
 * across the batches, so convergence never depends on the peer re-requesting a dropped op.
 *
 * `maxBytes` is the per-frame ceiling (defaults to the §27 {@link MAX_SYNC_MESSAGE_BYTES}); a caller on
 * a tighter transport may pass a smaller one.
 */
export function chunkOpResponseEnvelopes(
  envelopes: readonly PrivateEncryptedEnvelope[],
  maxBytes: number = MAX_SYNC_MESSAGE_BYTES,
): PrivateEncryptedEnvelope[][] {
  if (envelopes.length === 0) return [[]];
  const budget = maxBytes - OP_RESPONSE_FRAME_OVERHEAD;
  const batches: PrivateEncryptedEnvelope[][] = [];
  let current: PrivateEncryptedEnvelope[] = [];
  let used = 0;
  for (const envelope of envelopes) {
    const size = canonical(privateEncryptedEnvelopeSchema.parse(envelope) as CanonicalValue).length;
    if (
      current.length > 0 &&
      (used + size > budget || current.length >= MAX_ENVELOPES_PER_RESPONSE)
    ) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(envelope);
    used += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

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
  .strict()
  // PRIV-SYNC-1: enforce the declared §27 DoS bound.  Bound the BASE64URL char length (4 chars per 3
  // decoded bytes) so an over-cap commit is rejected BEFORE any base64 decode — a huge string never
  // reaches `decodeCommit`/`applyCommit`.
  .superRefine((msg, ctx) => {
    if (msg.commit.length > Math.ceil((MAX_MLS_COMMIT_BYTES * 4) / 3)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `MLS commit exceeds the ${MAX_MLS_COMMIT_BYTES}-byte cap`,
      });
    }
  });
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
    // A §14.5 archive is far larger than an inline op body (it is the full reduced state + retained
    // envelopes), so it uses the live-snapshot bound (fits one fragmented sync message), NOT the
    // small inline-ciphertext cap that silently rejected any real snapshot at encode (PRIV-SYNC-FRAGMENT).
    archive: liveSnapshotArchiveSchema,
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

/** Decode + strict-validate a sync message fail-closed (any malformed frame throws).  Decodes under
 *  the raised {@link MAX_SYNC_MESSAGE_BYTES} cap so a fully-budgeted `op_response`/`block_response`/
 *  `snapshot_response` — which the carrier fragments — is not rejected at the default 4 MiB limit. */
export function decodeSyncMessage(bytes: Uint8Array): SyncMessage {
  return syncMessageSchema.parse(decodeCanonical(bytes, SYNC_DECODE_LIMITS));
}
