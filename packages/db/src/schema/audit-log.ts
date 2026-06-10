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
