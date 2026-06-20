// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Strict schema for the detached proof body (OFFLINE_SPEC §10.2).  v0.2 proofs
// carry no `cose_unprotected` header — the protected header is the only header,
// keeping the body a closed schema; forward-compatible extension is via a
// `proof_version` bump, never stray keys (§9.1.4).

import { z } from 'zod';
import { bytesSchema, epochMsSchema, lcapRecordKindSchema, recordCidSchema } from './common.js';

export const proofKindSchema = z.enum([
  'device_signature',
  'authority_signature',
  'witness_signature',
]);

/** `proof_scope` (§10.2): optional room/expiry binding, never alg-bearing. */
export const proofScopeSchema = z
  .object({
    room_id_hash: bytesSchema.optional(),
    not_after_ms: epochMsSchema.optional(),
  })
  .strict();

export const detachedProofV2Schema = z
  .object({
    proof_version: z.literal(2),
    proof_kind: proofKindSchema,
    record_cid: recordCidSchema,
    record_kind: lcapRecordKindSchema,
    cose_protected: bytesSchema,
    external_aad: bytesSchema,
    signature: bytesSchema,
    signer_key_id: z.string().min(1),
    created_at_claim_ms: epochMsSchema.optional(),
    proof_scope: proofScopeSchema.optional(),
  })
  .strict();

export type DetachedProofV2Record = z.infer<typeof detachedProofV2Schema>;
