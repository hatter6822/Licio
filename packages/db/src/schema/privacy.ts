// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Privacy-control tables: DSAR export jobs (WS-D.2.2a) and account-deletion
// requests with their 30-day grace window (WS-D.2.4a).
import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const exportJobStateEnum = pgEnum('export_job_state', [
  'queued',
  'processing',
  'completed',
  'failed',
  'expired',
]);

export const exportJobs = pgTable(
  'export_jobs',
  {
    jobId: uuid('job_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    status: exportJobStateEnum('status').notNull().default('queued'),
    progressPct: integer('progress_pct').notNull().default(0),
    // Indirect reference to the stored object; the signed URL is minted per
    // request, never persisted in plaintext (WS-D.2.2c).
    downloadUrlRef: text('download_url_ref'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [index('export_jobs_user_idx').on(t.userId), index('export_jobs_status_idx').on(t.status)],
);

export const deletionStateEnum = pgEnum('deletion_state', ['grace_period', 'deleted', 'cancelled']);

export const deletionRequests = pgTable('deletion_requests', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.userId, { onDelete: 'cascade' }),
  state: deletionStateEnum('state').notNull().default('grace_period'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  // requested_at + 30 days; the scheduled purge runs at/after this instant.
  purgeAt: timestamp('purge_at', { withTimezone: true }).notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export type ExportJobRow = typeof exportJobs.$inferSelect;
export type DeletionRequestRow = typeof deletionRequests.$inferSelect;
