// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Takedown intake (WS-F.1.4f, SPEC §14.2/§18.1) — the mandatory
// copyright/legal removal path. Requests are PUBLIC intake (a rights holder
// need not hold an account) and are only actioned after steward review
// (WS-J.2 seam): the takedown path is itself an abuse vector (false takedowns
// to censor content), so nothing auto-removes.
//
// `requester_contact` is contact PII required for legal correspondence
// (DMCA-style); it is restricted to the steward surface, never appears on any
// public projection, and follows the moderation/legal retention class
// (§22.4).
import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const takedownTargetTypeEnum = pgEnum('takedown_target_type', [
  'story',
  'source',
  'evidence',
]);

export const takedownLegalBasisEnum = pgEnum('takedown_legal_basis', [
  'copyright',
  'privacy',
  'court_order',
  'other',
]);

export const takedownStatusEnum = pgEnum('takedown_status', [
  'received',
  'under_review',
  'actioned',
  'rejected',
]);

export const takedownRequests = pgTable(
  'takedown_requests',
  {
    takedownId: uuid('takedown_id').primaryKey().defaultRandom(),
    targetType: takedownTargetTypeEnum('target_type').notNull(),
    /** Polymorphic target (story/source/evidence id) — validated in service. */
    targetId: uuid('target_id').notNull(),
    requesterContact: text('requester_contact').notNull(),
    legalBasis: takedownLegalBasisEnum('legal_basis').notNull(),
    claimDetail: text('claim_detail').notNull(),
    status: takedownStatusEnum('status').notNull().default('received'),
    resolutionNote: text('resolution_note'),
    /** The steward who actioned/rejected; deletion keeps the audit trail. */
    actionedBy: uuid('actioned_by').references(() => users.userId, { onDelete: 'set null' }),
    actionedAt: timestamp('actioned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('takedown_requests_status_idx').on(t.status, t.createdAt),
    index('takedown_requests_target_idx').on(t.targetType, t.targetId),
    check('takedown_requests_detail_len', sql`char_length(${t.claimDetail}) between 10 and 5000`),
  ],
);

export type TakedownRequestRow = typeof takedownRequests.$inferSelect;
export type TakedownRequestInsert = typeof takedownRequests.$inferInsert;
