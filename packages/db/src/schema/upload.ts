// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contribution attachments (WS-G.3.7b, SPEC §15.5).  Upload BYTES live in the
// object store (in-memory in development, S3-compatible in production); this
// table is the metadata record.  Privacy: image metadata (EXIF/GPS/XMP) is
// stripped BEFORE storage — `metadata_stripped` records that the strip ran —
// and `scan_state` gates serving (the WS-J.2.6b seam: local checks now, the
// shared malware intelligence later).  Alt text is REQUIRED for images at the
// API layer (WCAG; null only for documents).
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const uploadScanStateEnum = pgEnum('upload_scan_state', ['pending', 'clear', 'flagged']);

export const uploads = pgTable(
  'uploads',
  {
    uploadId: uuid('upload_id').primaryKey().defaultRandom(),
    /** Nullable tombstone owner (account deletion anonymizes, WS-D.2.4). */
    ownerUserId: uuid('owner_user_id').references(() => users.userId, { onDelete: 'set null' }),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    altText: text('alt_text'),
    /** Object-store key for the stored (already-stripped) bytes. */
    storageRef: text('storage_ref').notNull(),
    metadataStripped: boolean('metadata_stripped').notNull(),
    scanState: uploadScanStateEnum('scan_state').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('uploads_owner_idx').on(t.ownerUserId),
    index('uploads_scan_idx').on(t.scanState),
    check(
      'uploads_content_type_allowed',
      sql`${t.contentType} in ('image/jpeg','image/png','image/webp','image/avif','application/pdf')`,
    ),
    check('uploads_byte_size_range', sql`${t.byteSize} between 1 and 10485760`),
    check(
      'uploads_alt_len',
      sql`${t.altText} is null or char_length(${t.altText}) between 1 and 500`,
    ),
  ],
);

export type UploadRow = typeof uploads.$inferSelect;
export type UploadInsert = typeof uploads.$inferInsert;
