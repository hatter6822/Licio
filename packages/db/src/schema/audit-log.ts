// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Append-only audit log for security- and privacy-relevant events (WS-D.1.6c).
// Entries carry NO credentials, NO session tokens, NO plaintext IPs — minimized
// metadata only (country-level location at most).  The application has no
// update/delete path; on account deletion the actor link is severed (set null)
// rather than the row removed, preserving forensic history (§25.4).
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const auditEventTypeEnum = pgEnum('audit_event_type', [
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
  // WS-E: retention-sweep summaries and PWAtt safety-state transitions
  // (mirrors AUDIT_EVENT_TYPES in @licio/shared).
  'retention_sweep',
  'safety_state_change',
  // WS-E steward surface: validated PWAtt runtime-config writes.
  'pwatt_config_change',
  // WS-F steward surface (mirrors AUDIT_EVENT_TYPES in @licio/shared).
  'source_profile_edit',
  'syndication_change',
  'takedown_action',
  'ingestion_review_action',
  'ingestion_config_change',
  // WS-G forum surface (mirrors AUDIT_EVENT_TYPES in @licio/shared).
  'thread_state_change',
  'contribution_moderation_change',
  'evidence_verification_change',
  'summary_change',
  'room_steward_change',
  'forum_config_change',
  'invariant_config_change',
  'invariant_promotion_change',
  'mfci_case_action',
  'scoi_context_action',
  'bridge_request',
  // WS-I ranking surface (mirrors AUDIT_EVENT_TYPES in @licio/shared).
  'ranking_config_change',
  'ranking_killswitch_change',
  'ranking_decision_query',
  'ranking_replay_run',
  // WS-Q content–room model: visibility transitions (migration 0019).
  'story_visibility_change',
  'room_visibility_change',
  // WS-L Knomosis gateway/wallets (mirrors AUDIT_EVENT_TYPES; migration 0059).
  'wallet_label_change',
  'knomosis_killswitch_change',
  'knomosis_preflight',
  'knomosis_action_submit',
  'knomosis_config_change',
  'governance_mode_change',
  'governance_sim_action',
]);

export const auditLog = pgTable(
  'audit_log',
  {
    eventId: uuid('event_id').primaryKey().defaultRandom(),
    // Severed (not cascaded) on deletion: the audit trail outlives the account.
    actorUserId: uuid('actor_user_id').references(() => users.userId, { onDelete: 'set null' }),
    eventType: auditEventTypeEnum('event_type').notNull(),
    targetRef: text('target_ref'), // hashed where it is a token/session id
    context: jsonb('context').notNull(), // minimized: country/device/method/setting diffs
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_actor_idx').on(t.actorUserId),
    index('audit_log_actor_created_idx').on(t.actorUserId, t.createdAt),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
