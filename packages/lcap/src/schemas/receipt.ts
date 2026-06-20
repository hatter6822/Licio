// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Receipt + object-status schemas (OFFLINE_SPEC §16.11, §20.4).  Receipts are
// availability HINTS and audit evidence — they advance liveness and feed the
// scarcity boost, but they do NOT prove the truth of content (a receipt never
// raises a record's trust state).

import { z } from 'zod';
import { anyCidSchema, cidKindSchema, epochMsSchema } from './common.js';

export const objectStatusCodeSchema = z.enum([
  'accepted',
  'already_have',
  'stored_pending',
  'stored_unverified',
  'quarantined_missing_dependency',
  'quarantined_unknown_key',
  'quarantined_stale_checkpoint',
  'quarantined_policy_review',
  'conflict_device_fork',
  'rejected_bad_cid',
  'rejected_bad_schema',
  'rejected_bad_signature',
  'rejected_high_s_signature',
  'rejected_revoked',
  'rejected_capability_expired',
  'rejected_policy_denied',
  'rejected_quota',
  'rejected_resource_limit',
]);

export const objectStatusV2Schema = z
  .object({
    cid: anyCidSchema,
    cid_kind: cidKindSchema,
    status: objectStatusCodeSchema,
    missing_cids: z.array(anyCidSchema).optional(),
    detail_code: z.string().min(1).optional(),
    receipt_cid: anyCidSchema.optional(),
  })
  .strict();

export const receiptRecordV2Schema = z
  .object({
    record_version: z.literal(2),
    kind: z.literal('receipt'),
    receipt_type: z.enum([
      'stored',
      'accepted',
      'rejected',
      'quarantined',
      'evicted',
      'checkpointed',
    ]),
    issuer_node_id: z.string().min(1),
    subject_cids: z.array(anyCidSchema),
    issued_at_claim_ms: epochMsSchema.optional(),
    storage_until_claim_ms: epochMsSchema.optional(),
    status_detail: z.array(objectStatusV2Schema).optional(),
  })
  .strict();

export type ReceiptRecordV2 = z.infer<typeof receiptRecordV2Schema>;
