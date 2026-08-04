// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Distributed job leases (WS-D.2.2c/2.4a scheduler binding).  One row per job
// name; an instance owns the job until `locked_until`.  The claim is a single
// atomic INSERT … ON CONFLICT DO UPDATE … WHERE locked_until <= now RETURNING,
// so exactly one of N concurrent claimants wins a window.  No FK edges: leases
// reference jobs by name, never user data.
import { pgTable, text } from 'drizzle-orm/pg-core';
import { instant } from './_custom.js';

export const jobLeases = pgTable('job_leases', {
  jobName: text('job_name').primaryKey(),
  lockedUntil: instant('locked_until').notNull(),
  // A coarse instance label (host:pid) for operational visibility only.
  holder: text('holder').notNull(),
  acquiredAt: instant('acquired_at').notNull().defaultNow(),
});

export type JobLeaseRow = typeof jobLeases.$inferSelect;
