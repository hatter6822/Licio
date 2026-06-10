// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Audit-log event taxonomy and the user-facing "recent security activity" view
// (WS-D.1.6c).  The log is append-only and minimized: entries never carry
// credentials, session tokens, or plaintext IPs — country-level location only.
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { authMethodSchema } from './identity-records.js';

/** The closed set of security- and privacy-relevant audit events. */
export const AUDIT_EVENT_TYPES = [
  'login_success',
  'login_failure',
  'session_create',
  'session_revoke',
  'auth_method_add',
  'auth_method_remove',
  'mfa_enroll',
  'mfa_verify',
  'mfa_disable',
  'privacy_setting_change',
  'export_request',
  'export_download',
  'deletion_request',
  'deletion_cancel',
  'deletion_complete',
  'attention_delete',
  'wallet_link',
  'wallet_unlink',
  'role_change',
  'suspicious_login',
  'account_lockout',
  'authz_denied',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export const auditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);

/**
 * Minimized event context.  No raw IP, no secrets — country code, a coarse
 * device label, and the auth method are the most that is ever recorded.
 */
export const auditContextSchema = z
  .object({
    // Privacy amendment (SPEC §19.1): NO country/location and NO IP. A coarse
    // device descriptor is the most location-like value ever recorded.
    device: z.string().max(128).nullable(),
    auth_method: authMethodSchema.nullable(),
    /** For privacy_setting_change: the changed flag and its old→new values. */
    setting: z.string().max(128).nullable(),
    previous_value: z.string().max(256).nullable(),
    new_value: z.string().max(256).nullable(),
  })
  .strict();
export type AuditContext = z.infer<typeof auditContextSchema>;

/** A full audit entry as stored (actor + minimized context). */
export const auditEntrySchema = z
  .object({
    event_id: uuidSchema,
    /** The acting user, or null for system-initiated events. */
    actor_user_id: uuidSchema.nullable(),
    event_type: auditEventTypeSchema,
    /** Hashed where the target is a token/session; never a raw secret. */
    target_ref: z.string().nullable(),
    context: auditContextSchema,
    created_at: isoTimestampSchema,
  })
  .strict();
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** The owner-visible subset (no actor field beyond self, no target_ref). */
export const securityActivityEntrySchema = z
  .object({
    event_id: uuidSchema,
    event_type: auditEventTypeSchema,
    context: auditContextSchema,
    created_at: isoTimestampSchema,
  })
  .strict();
export type SecurityActivityEntry = z.infer<typeof securityActivityEntrySchema>;

export const securityActivityResponseSchema = z
  .object({ activity: z.array(securityActivityEntrySchema) })
  .strict();
export type SecurityActivityResponse = z.infer<typeof securityActivityResponseSchema>;
