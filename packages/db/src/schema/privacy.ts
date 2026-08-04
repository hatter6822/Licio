// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Privacy-control tables: DSAR export jobs (WS-D.2.2a) and account-deletion
// requests with their 30-day grace window (WS-D.2.4a).
import { index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant } from './_custom.js';
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
    createdAt: instant('created_at').notNull().defaultNow(),
    completedAt: instant('completed_at'),
    expiresAt: instant('expires_at'),
  },
  (t) => [index('export_jobs_user_idx').on(t.userId), index('export_jobs_status_idx').on(t.status)],
);

export const deletionStateEnum = pgEnum('deletion_state', ['grace_period', 'deleted', 'cancelled']);

export const deletionRequests = pgTable('deletion_requests', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.userId, { onDelete: 'cascade' }),
  state: deletionStateEnum('state').notNull().default('grace_period'),
  requestedAt: instant('requested_at').notNull().defaultNow(),
  // requested_at + 30 days; the scheduled purge runs at/after this instant.
  purgeAt: instant('purge_at').notNull(),
  cancelledAt: instant('cancelled_at'),
  completedAt: instant('completed_at'),
});

export type ExportJobRow = typeof exportJobs.$inferSelect;
export type DeletionRequestRow = typeof deletionRequests.$inferSelect;
