// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wire contracts for the WS-D authentication endpoints (/v1/auth/*).  These are
// validated by the BFF's zValidator on the way in and re-validated before any
// response leaves the boundary (the WS-C.1.2 guarantee), and they are the types
// the future PWA auth client (WS-D.1.2d) consumes.
//
// WebAuthn attestation/assertion payloads are validated STRUCTURALLY here; the
// authoritative cryptographic verification is performed by @simplewebauthn on the
// server (WS-D.1.2b/1.3a).  SIWE messages are validated structurally here and
// verified cryptographically by viem (WS-D.1.4c).
import { z } from 'zod';
import { uuidSchema } from './common.js';
import { sessionSummarySchema } from './identity-records.js';
import { ageBandSchema, emailSchema, handleSchema, userPublicSchema } from './user.js';

/** A successfully established session (the user's public view is echoed back). */
export const authSessionResultSchema = z
  .object({
    status: z.literal('authenticated'),
    user: userPublicSchema,
  })
  .strict();
export type AuthSessionResult = z.infer<typeof authSessionResultSchema>;

/** Returned (401) when a sensitive action needs a fresh step-up assertion. */
export const stepUpRequiredSchema = z
  .object({
    status: z.literal('step_up_required'),
    /** Methods the client may use to satisfy the step-up. */
    methods: z.array(z.enum(['webauthn', 'email_otp', 'wallet'])),
  })
  .strict();
export type StepUpRequired = z.infer<typeof stepUpRequiredSchema>;

/** A generic, enumeration-safe acknowledgement (identical for present/absent accounts). */
export const genericAckSchema = z.object({ status: z.literal('accepted') }).strict();
export type GenericAck = z.infer<typeof genericAckSchema>;

// ---------------------------------------------------------------------------
// Registration (passwordless).  The age screen sends a date of birth; the server
// derives the band, blocks under-13, and discards the DOB (WS-D.1.7a).
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` date of birth — used transiently for banding, never stored. */
export const dateOfBirthSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'date of birth must be YYYY-MM-DD',
});

export const emailRegisterRequestSchema = z
  .object({
    handle: handleSchema,
    display_name: z.string().min(1).max(80),
    email: emailSchema,
    date_of_birth: dateOfBirthSchema,
  })
  .strict();
export type EmailRegisterRequest = z.infer<typeof emailRegisterRequestSchema>;

// ---------------------------------------------------------------------------
// Email one-time-code (OTP) login + factor verification (WS-D.1.4a/b).
// ---------------------------------------------------------------------------
export const emailStartRequestSchema = z.object({ email: emailSchema }).strict();
export type EmailStartRequest = z.infer<typeof emailStartRequestSchema>;

/** Crockford-base32 one-time code: 8 chars, normalized client-side to upper-case. */
export const oneTimeCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z]{8}$/, { message: 'code must be 8 characters' });

export const emailVerifyRequestSchema = z.object({ code: oneTimeCodeSchema }).strict();
export type EmailVerifyRequest = z.infer<typeof emailVerifyRequestSchema>;

// ---------------------------------------------------------------------------
// WebAuthn (WS-D.1.2/1.3).  Response payloads are structurally validated; the
// library performs the cryptographic verification.
// ---------------------------------------------------------------------------
export const webauthnRegistrationResponseSchema = z
  .object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string().min(1),
        attestationObject: z.string().min(1),
        transports: z.array(z.string()).optional(),
      })
      .passthrough(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    authenticatorAttachment: z.string().optional(),
  })
  .passthrough();

export const webauthnRegisterVerifyRequestSchema = z
  .object({
    response: webauthnRegistrationResponseSchema,
    device_name: z.string().min(1).max(128).optional(),
  })
  .strict();
export type WebAuthnRegisterVerifyRequest = z.infer<typeof webauthnRegisterVerifyRequestSchema>;

export const webauthnAuthenticationResponseSchema = z
  .object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string().min(1),
        authenticatorData: z.string().min(1),
        signature: z.string().min(1),
        userHandle: z.string().optional(),
      })
      .passthrough(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    authenticatorAttachment: z.string().optional(),
  })
  .passthrough();

export const webauthnAuthenticateVerifyRequestSchema = z
  .object({ response: webauthnAuthenticationResponseSchema })
  .strict();
export type WebAuthnAuthenticateVerifyRequest = z.infer<
  typeof webauthnAuthenticateVerifyRequestSchema
>;

// ---------------------------------------------------------------------------
// Sign-In with Ethereum (EIP-4361 / SIWE), WS-D.1.4c.  Adult-only, opt-in.
// ---------------------------------------------------------------------------
export const siweNonceResponseSchema = z
  .object({
    nonce: z.string().min(8),
    /** ISO issued-at the client must echo into the EIP-4361 message. */
    issued_at: z.string().datetime(),
  })
  .strict();
export type SiweNonceResponse = z.infer<typeof siweNonceResponseSchema>;

export const siweVerifyRequestSchema = z
  .object({
    /** The full EIP-4361 message string the user signed. */
    message: z.string().min(1).max(4096),
    /** Hex signature (0x-prefixed) — EOA, EIP-1271, or EIP-6492 wrapped. */
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/, { message: 'signature must be 0x-hex' }),
    /** Profile fields, required only on first-time wallet signup. */
    handle: handleSchema.optional(),
    display_name: z.string().min(1).max(80).optional(),
    date_of_birth: dateOfBirthSchema.optional(),
  })
  .strict();
export type SiweVerifyRequest = z.infer<typeof siweVerifyRequestSchema>;

// ---------------------------------------------------------------------------
// Active sessions (WS-D.1.3c).
// ---------------------------------------------------------------------------
export const sessionListResponseSchema = z
  .object({ sessions: z.array(sessionSummarySchema) })
  .strict();
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

// ---------------------------------------------------------------------------
// Steward TOTP MFA (WS-D.1.5).
// ---------------------------------------------------------------------------
export const totpEnrollResponseSchema = z
  .object({
    otpauth_uri: z.string().startsWith('otpauth://'),
  })
  .strict();
export type TotpEnrollResponse = z.infer<typeof totpEnrollResponseSchema>;

/** A 6-digit TOTP code, or an 8+ char recovery code. */
export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{6}$/, { message: 'expected 6 digits' });
export const recoveryCodeSchema = z.string().trim().min(8).max(32);

export const totpConfirmRequestSchema = z.object({ code: totpCodeSchema }).strict();
export type TotpConfirmRequest = z.infer<typeof totpConfirmRequestSchema>;

export const totpConfirmResponseSchema = z
  .object({ recovery_codes: z.array(z.string().min(8)).length(10) })
  .strict();
export type TotpConfirmResponse = z.infer<typeof totpConfirmResponseSchema>;

export const totpVerifyRequestSchema = z
  .object({ code: z.union([totpCodeSchema, recoveryCodeSchema]) })
  .strict();
export type TotpVerifyRequest = z.infer<typeof totpVerifyRequestSchema>;

/** The authenticated user's enrolled credentials (WS-D.1.2c management surface). */
export const credentialListResponseSchema = z
  .object({
    passkeys: z.array(
      z
        .object({
          credential_id: z.string().min(1),
          device_name: z.string().nullable(),
          device_type: z.string(),
          backed_up: z.boolean(),
          created_at: z.string().datetime(),
          last_used_at: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    wallets: z.array(
      z
        .object({
          credential_id: uuidSchema,
          address_truncated: z.string(),
          chain_id: z.number().int().positive(),
          created_at: z.string().datetime(),
          last_used_at: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    email: z.object({ present: z.boolean(), verified: z.boolean() }).strict(),
    /** TOTP enrolment state (drives the two-factor management UI, WS-D.1.5). */
    totp: z.object({ enabled: z.boolean(), pending: z.boolean() }).strict(),
  })
  .strict();
export type CredentialListResponse = z.infer<typeof credentialListResponseSchema>;

/** Age band echoed to the client after registration (drives UI gating, never DOB). */
export const registeredAgeBandSchema = z.object({ age_band: ageBandSchema }).strict();

/** Path param shape for session revocation. */
export const sessionIdParamSchema = z.object({ sessionId: uuidSchema }).strict();
