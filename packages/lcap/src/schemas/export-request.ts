// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bundle-export authorization request (OFFLINE_SPEC §29.8 export gate, WS-R.12.4).  A
// server-side room export discloses the room's accepted content closure — which may hold
// in_room content — so it must be authorized, not open to anyone who knows a room id.  The
// requesting device signs this small request (a `device_signature` detached proof over its
// canonical body, `record_kind: 'export_request'`); the server verifies the signature
// against the device's authority-verified certificate AND that the device holds a
// non-revoked `may_export_bundle` capability for the room, within a freshness window.

import { z } from 'zod';
import { bytesSchema, epochMsSchema, recordCidSchema } from './common.js';

export const exportRequestV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('export_request'),
    /** The room whose content closure is being requested. */
    room_id: z.string().min(1),
    /** The capability (a room_capability record CID) the requester relies on to export. */
    capability_cid: recordCidSchema,
    /** When the request was minted (the server enforces a freshness window around it). */
    issued_at_ms: epochMsSchema,
    /** A per-request nonce so two requests never share bytes (replay-cache friendly). */
    request_nonce: bytesSchema,
  })
  .strict();

export type ExportRequestV2 = z.infer<typeof exportRequestV2Schema>;

/** The wire envelope a client POSTs: the request plus the device signature over its body. */
export const exportRequestEnvelopeV2Schema = z
  .object({
    request: exportRequestV2Schema,
    // The detached `device_signature` proof; carried as raw LDC bytes and decoded by the
    // server through `decodeProof` so the proof schema owns its own validation.
    proof_body: bytesSchema,
  })
  .strict();

export type ExportRequestEnvelopeV2 = z.infer<typeof exportRequestEnvelopeV2Schema>;
