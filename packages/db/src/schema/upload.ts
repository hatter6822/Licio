// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contribution attachments (WS-G.3.7b, SPEC §15.5).  Upload BYTES live in the
// object store (S3-compatible when the S3_* group is configured, else the
// durable `upload_blobs` Postgres fallback below — production is durable and
// instance-shared in BOTH configurations); this table is the metadata record.  Privacy: image metadata (EXIF/GPS/XMP) is
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
import { bytea } from './_custom.js';
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
    /**
     * WS-Q.5.2c — back-reference to the story whose media this upload is (main
     * media, caption track, or poster). Set at story submission; `null` for
     * contribution attachments. The gated serving path uses it to re-derive the
     * upload's visibility (a `room_only` story requires a signed URL) and to
     * re-check takedown at fetch time. Declared without a Drizzle `.references()`
     * to avoid a circular uploads↔stories schema import; the FK is added in the
     * migration SQL (ON DELETE SET NULL).
     */
    ownerStoryId: uuid('owner_story_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('uploads_owner_idx').on(t.ownerUserId),
    index('uploads_scan_idx').on(t.scanState),
    index('uploads_owner_story_idx').on(t.ownerStoryId),
    // WS-Q.2.3c — the allowlist gains the two video containers (mp4/webm); the
    // shared allowlist (forum/safety.ts) mirrors this exactly (parity-tested).
    check(
      'uploads_content_type_allowed',
      sql`${t.contentType} in ('image/jpeg','image/png','image/webp','image/avif','image/gif','video/mp4','video/webm','text/vtt')`,
    ),
    // Video posts are larger than images; the per-type byte cap (image 10 MB,
    // video 200 MB) is enforced at the API layer (ingestion.video_max_bytes).
    // The table CHECK keeps a hard 200 MB ceiling so a bad write cannot store
    // an unbounded blob.
    check('uploads_byte_size_range', sql`${t.byteSize} between 1 and 209715200`),
    check(
      'uploads_alt_len',
      sql`${t.altText} is null or char_length(${t.altText}) between 1 and 500`,
    ),
  ],
);

/** The durable Postgres binding for upload BYTES when S3 is not configured.
 *  Separate from `uploads` so metadata reads never drag the blob across the
 *  wire; the CASCADE keeps blob lifetime ≤ metadata lifetime (a purged
 *  metadata row can never strand orphaned bytes).  Size is bounded by the
 *  `uploads` byte-size CHECK (≤ 200 MB) enforced at the API layer per type. */
export const uploadBlobs = pgTable('upload_blobs', {
  uploadId: uuid('upload_id')
    .primaryKey()
    .references(() => uploads.uploadId, { onDelete: 'cascade' }),
  bytes: bytea('bytes').notNull(),
});

export type UploadRow = typeof uploads.$inferSelect;
export type UploadInsert = typeof uploads.$inferInsert;
export type UploadBlobRow = typeof uploadBlobs.$inferSelect;
