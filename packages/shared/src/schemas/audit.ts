// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Audit-log event taxonomy and the user-facing "recent security activity" view
// (WS-D.1.6c).  The log is append-only and minimized: entries never carry
// credentials, session tokens, IPs, or location of ANY granularity (§19.1) —
// a coarse device descriptor is the most context an entry may hold.
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
  // WS-E: retention-sweep summaries (counts only, never payloads) and PWAtt
  // safety-state freeze/unfreeze/remove transitions (WS-E.1.4 / WS-E.2.3e).
  'retention_sweep',
  'safety_state_change',
  // WS-E steward surface: validated PWAtt runtime-config writes.
  'pwatt_config_change',
  // WS-F ingestion/source/search steward surface: audited source-profile
  // edits (WS-F.2.3a), syndication create/confirm (WS-F.2.4), takedown
  // actions (WS-F.1.4f), review-queue resolutions, and validated ingestion
  // runtime-config writes.
  'source_profile_edit',
  'syndication_change',
  'takedown_action',
  'ingestion_review_action',
  'ingestion_config_change',
  // WS-G forum surface: thread conversation/safety transitions (WS-G.1.1),
  // contribution moderation-state changes, summary creation/approval
  // (WS-G.1.4), room steward/join-request decisions (WS-G.2.3c/d), and
  // validated forum runtime-config writes.
  'thread_state_change',
  'contribution_moderation_change',
  'summary_change',
  'room_steward_change',
  'forum_config_change',
  // WS-H invariant platform: validated invariants runtime-config writes,
  // shadow-status promotions/demotions (WS-H.1.2e), MFCI analyst case
  // resolutions (WS-H.3.4b), and bridge-request routing (WS-H.4.2d).
  // (`scoi_context_action` was retired with the WS-H.4.3d moderator
  // merge/annotate/separate surface; historic rows keep the label in the
  // append-only DB enum — this LIVE mirror deliberately omits it.)
  'invariant_config_change',
  'invariant_promotion_change',
  'mfci_case_action',
  'bridge_request',
  // WS-I ranking: validated ranking runtime-config writes (WS-I.2.3f),
  // kill-switch engage/release (WS-I.4.1a), decision-log queries (the
  // WS-I.2.5c meta-audit -- every read of ranking decisions is itself
  // audited), and replay runs (WS-I.2.5b).
  'ranking_config_change',
  'ranking_killswitch_change',
  'ranking_decision_query',
  'ranking_replay_run',
  // WS-Q content–room model: content-visibility transitions (author
  // narrow/widen, migration) and room public⇄private visibility cascades.
  // Join-model/posting-policy governance writes keep using
  // `forum_config_change`; only visibility transitions use these two.
  'story_visibility_change',
  'room_visibility_change',
  // WS-L Knomosis gateway, wallets, and receipts: financial-surface changes.
  // `wallet_link`/`wallet_unlink` (WS-D block above) cover the link lifecycle;
  // these add the label edit, the kill-switch registry, gateway submissions,
  // governance-mode transitions, and the simulated-governance surface.
  'wallet_label_change',
  'knomosis_killswitch_change',
  'knomosis_preflight',
  'knomosis_action_submit',
  'knomosis_config_change',
  'governance_mode_change',
  'governance_sim_action',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export const auditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);

/**
 * Minimized event context.  No IP, no location, no secrets — a coarse device
 * label and the auth method are the most that is ever recorded (§19.1).
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
    /** WS-G.1.1 transitions: the human-stated reason for the change. */
    reason: z.string().max(256).nullable(),
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
