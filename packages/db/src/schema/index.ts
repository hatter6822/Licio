// SPDX-License-Identifier: AGPL-3.0-or-later
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const placeholder = pgTable('_placeholder', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  note: text('note'),
});
