// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — `VoluntaryPrivateReportPackageV1` (PRIVATE_SPEC §19.4): the ONLY
// way private content reaches the platform — a member VOLUNTARILY discloses
// selected items (the platform cannot scan content it cannot read, §6.6).  This
// is a local export artifact, not a server-stored object; a reporter chooses
// exactly what to disclose, with redaction notes + an attestation.
import { z } from 'zod';
import { base64UrlSchema, privateCidSchema, privateIdSchema } from './common.js';

/** One disclosed item within a voluntary report (the reporter's choice). */
export const privateDisclosedItemSchema = z
  .object({
    kind: z.enum(['story', 'thread', 'contribution', 'media', 'membership_op']),
    /** The decrypted item the reporter chose to disclose (their content). */
    plaintext_json: z.unknown().optional(),
    /** A reference to a disclosed media file (out-of-band). */
    plaintext_media_file: z.string().min(1).max(1_024).optional(),
    /** The encrypted-envelope CID the disclosure corresponds to. */
    envelope_cid: privateCidSchema.optional(),
    signatures: z.array(base64UrlSchema).max(64),
    author_device_keys: z.array(base64UrlSchema).max(64),
    context_notes: z.string().max(5_000).optional(),
  })
  .strict();

export const voluntaryPrivateReportPackageSchema = z
  .object({
    schema: z.literal('licio.private.report_package.v1'),
    report_id: privateIdSchema,
    /** The reporter's Licio account (optional — a report MAY be account-linked). */
    reporter_account_id: privateIdSchema.optional(),
    /** The optional directory stub id (listed/unlisted rooms only). */
    room_stub_id: privateIdSchema.optional(),
    disclosed_items: z.array(privateDisclosedItemSchema).min(1).max(1_000),
    redaction_notes: z.string().max(5_000),
    reporter_attestation: z.string().min(1).max(5_000),
    created_at: z.string().min(1).max(64),
  })
  .strict();
export type VoluntaryPrivateReportPackage = z.infer<typeof voluntaryPrivateReportPackageSchema>;
