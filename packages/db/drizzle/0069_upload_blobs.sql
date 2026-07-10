-- Durable upload BYTES without S3 (WS-G.3.7b / WS-Q.5.2c production parity).
--
-- The Drizzle upload store previously fell back to a restart-volatile,
-- per-instance in-memory map for blob bytes when the S3_* group was unset —
-- the metadata row then claimed an object other instances could not serve and
-- a restart destroyed.  `upload_blobs` is the durable Postgres binding for
-- that configuration: bytes live here (S3 remains the preferred binding when
-- configured), separate from `uploads` so metadata reads never drag the blob,
-- with ON DELETE CASCADE so a purged metadata row can never strand orphaned
-- bytes.
CREATE TABLE "upload_blobs" (
	"upload_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upload_blobs" ADD CONSTRAINT "upload_blobs_upload_id_uploads_upload_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("upload_id") ON DELETE cascade ON UPDATE no action;
