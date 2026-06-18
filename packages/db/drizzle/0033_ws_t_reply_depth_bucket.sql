-- WS-T.2.5 — durable reply-depth bucket expansion. Keep branch_depth_bucket
-- through the deploy window; ingest writes both columns and PWAtt reads the new
-- column with old-column fallback for pre-backfill rows.
DO $$ BEGIN
  CREATE TYPE "public"."reply_depth_bucket" AS ENUM('none', 'shallow', 'moderate', 'deep');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "attention_aggregates" ADD COLUMN IF NOT EXISTS "reply_depth_bucket" "public"."reply_depth_bucket";--> statement-breakpoint
UPDATE "attention_aggregates"
SET "reply_depth_bucket" = "branch_depth_bucket"::text::"public"."reply_depth_bucket"
WHERE "reply_depth_bucket" IS NULL;--> statement-breakpoint
ALTER TABLE "attention_aggregates" ALTER COLUMN "reply_depth_bucket" SET NOT NULL;
