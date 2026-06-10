// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Distributed job leases (WS-D.2.2c/2.4a scheduler binding).  One row per job
// name; an instance owns the job until `locked_until`.  The claim is a single
// atomic INSERT … ON CONFLICT DO UPDATE … WHERE locked_until <= now RETURNING,
// so exactly one of N concurrent claimants wins a window.  No FK edges: leases
// reference jobs by name, never user data.
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const jobLeases = pgTable('job_leases', {
  jobName: text('job_name').primaryKey(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }).notNull(),
  // A coarse instance label (host:pid) for operational visibility only.
  holder: text('holder').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
});

export type JobLeaseRow = typeof jobLeases.$inferSelect;
