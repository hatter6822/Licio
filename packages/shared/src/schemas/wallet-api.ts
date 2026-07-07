// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2 wallet wire contracts (SPEC §17.3.1, §23.4, §23.5).  The financial
// wallet-link surface: SIWE nonce → link → list/label → unlink lifecycle →
// risk state.  Both the BFF (response construction) and the PWA (zod
// validation before the TanStack Query cache) reference these shapes.
//
// Data-minimization invariants (SPEC §19.5): NO wire shape here carries a full
// wallet address — only the first-6+last-4 truncation; the keyed address hash
// never leaves the server.  There is no seed-phrase or private-key field
// anywhere (no-custody, §17.3.1) — asserted by unit test.

import { z } from 'zod';
import { isoTimestampSchema, paginatedSchema, uuidSchema } from './common.js';
import {
  unlinkStateSchema,
  walletAccountTypeSchema,
  walletRiskStateSchema,
} from './identity-records.js';

/** A 0x-prefixed 65-byte (r‖s‖v) hex signature, as produced by personal_sign. */
export const walletSignatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130,4096}$/, { message: 'must be a 0x-prefixed hex signature' });

// ---------------------------------------------------------------------------
// POST /v1/wallet/nonce (WS-L.2.3a)
// ---------------------------------------------------------------------------

export const walletNonceResponseSchema = z
  .object({
    /** CSPRNG nonce (≥16 bytes entropy), single-use, session-bound. */
    nonce: z.string().min(8).max(96),
    issued_at: isoTimestampSchema,
    expires_at: isoTimestampSchema,
  })
  .strict();
export type WalletNonceResponse = z.infer<typeof walletNonceResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/wallet/link (WS-L.2.5a)
// ---------------------------------------------------------------------------

export const walletLinkRequestSchema = z
  .object({
    /** The exact EIP-4361 message string the wallet signed (WS-L.2.3b). */
    message: z.string().min(1).max(4_000),
    signature: walletSignatureSchema,
    /** Optional user-defined display label. */
    label: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type WalletLinkRequest = z.infer<typeof walletLinkRequestSchema>;

/** The owner-facing wallet projection (never a full address, WS-L.2.5c). */
export const walletSummarySchema = z
  .object({
    wallet_account_id: uuidSchema,
    /** User label, defaulted server-side to "Wallet N" when unset. */
    label: z.string().min(1).max(64),
    address_truncated: z.string().min(1).max(64),
    chain_id: z.number().int().positive(),
    wallet_type: walletAccountTypeSchema,
    unlink_state: unlinkStateSchema,
    risk_state: walletRiskStateSchema,
    linked_at: isoTimestampSchema,
    last_used_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type WalletSummary = z.infer<typeof walletSummarySchema>;

export const walletLinkResponseSchema = z
  .object({
    wallet: walletSummarySchema,
    /** True when this call re-linked an already-linked wallet (idempotent). */
    already_linked: z.boolean(),
  })
  .strict();
export type WalletLinkResponse = z.infer<typeof walletLinkResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/wallets (WS-L.2.5c) + PATCH /v1/wallets/:id (label)
// ---------------------------------------------------------------------------

export const walletListQuerySchema = z
  .object({
    include_unlinked: z.enum(['true', 'false']).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type WalletListQuery = z.infer<typeof walletListQuerySchema>;

export const walletListResponseSchema = paginatedSchema(walletSummarySchema);
export type WalletListResponse = z.infer<typeof walletListResponseSchema>;

export const walletLabelRequestSchema = z
  .object({ label: z.string().trim().min(1).max(64) })
  .strict();
export type WalletLabelRequest = z.infer<typeof walletLabelRequestSchema>;

// ---------------------------------------------------------------------------
// POST /v1/wallet/unlink/request (WS-L.2.5b)
// ---------------------------------------------------------------------------

export const walletUnlinkRequestSchema = z.object({ wallet_account_id: uuidSchema }).strict();
export type WalletUnlinkRequest = z.infer<typeof walletUnlinkRequestSchema>;

/** The obligation kinds that block an unlink (WS-L.2.5b). */
export const UNLINK_OBLIGATION_TYPES = [
  'pending_grant',
  'active_proposal',
  'pending_payment',
  'steward_role',
] as const;
export type UnlinkObligationType = (typeof UNLINK_OBLIGATION_TYPES)[number];

export const unlinkObligationSchema = z
  .object({
    type: z.enum(UNLINK_OBLIGATION_TYPES),
    /** Opaque reference to the blocking item (proposal/grant/intent id). */
    ref: z.string().min(1).max(128),
    description: z.string().min(1).max(500),
  })
  .strict();
export type UnlinkObligation = z.infer<typeof unlinkObligationSchema>;

/** 200 — the unlink was accepted and cooling-off scheduled. */
export const walletUnlinkAcceptedSchema = z
  .object({
    wallet_account_id: uuidSchema,
    unlink_state: z.literal('pending_unlink'),
    /** When the unlink finalizes unless cancelled (cooling-off, default 24h). */
    finalize_after: isoTimestampSchema,
  })
  .strict();
export type WalletUnlinkAccepted = z.infer<typeof walletUnlinkAcceptedSchema>;

/** 409 — blocked with the specific obligations (WS-L.2.5b). */
export const walletUnlinkBlockedSchema = z
  .object({
    error: z
      .object({
        code: z.literal('unlink_blocked'),
        message: z.string().min(1),
      })
      .strict(),
    blocking_obligations: z.array(unlinkObligationSchema).min(1).max(100),
  })
  .strict();
export type WalletUnlinkBlocked = z.infer<typeof walletUnlinkBlockedSchema>;

// ---------------------------------------------------------------------------
// GET /v1/wallets/:id/risk-state (WS-L.2.5c-1)
// ---------------------------------------------------------------------------

export const walletRiskStateResponseSchema = z
  .object({
    wallet_account_id: uuidSchema,
    risk_state: walletRiskStateSchema,
    /** Plain-language explanation; never raw sanctions/fraud internals. */
    explanation: z.string().min(1).max(500),
    /** User-actionable next step, when one exists. */
    next_step: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type WalletRiskStateResponse = z.infer<typeof walletRiskStateResponseSchema>;
