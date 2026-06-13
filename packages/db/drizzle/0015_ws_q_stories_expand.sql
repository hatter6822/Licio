-- WS-Q.1.4a — stories EXPAND step (additive, online-safe). Adds the four new
-- columns nullable/defaulted, appends the two media submission types, and seeds
-- the system Commons room so 0016's backfill can target it deterministically.
--
-- This step is purely additive: existing rows are NOT rewritten (a defaulted
-- column add is metadata-only in PG >= 11; an enum ADD VALUE is non-locking; an
-- all-NULL FK column validates instantly). The NOT NULL / uniqueness contracts
-- land in 0016/0017, AFTER the dual-write serving code deploys everywhere (see
-- "Deploy ordering" in docs/planning/18-content-and-room-model.md).
ALTER TYPE "public"."story_submission_type" ADD VALUE IF NOT EXISTS 'image_post';--> statement-breakpoint
ALTER TYPE "public"."story_submission_type" ADD VALUE IF NOT EXISTS 'video_post';--> statement-breakpoint
CREATE TYPE "public"."story_visibility" AS ENUM('public', 'room_only');--> statement-breakpoint
-- Seed the pinned Commons room (id mirrors @licio/shared COMMONS_ROOM_ID).
-- ON CONFLICT keeps a re-run a no-op (the migration-validation harness re-runs
-- the chain). Created BEFORE the stories columns so the room_id FK resolves.
INSERT INTO "rooms" ("room_id", "name", "slug", "description", "room_type", "visibility", "join_model", "posting_policy", "type_metadata")
VALUES ('c0000000-0000-4000-8000-000000000000', 'Commons', 'commons', 'The shared public square — the default home for content without a more specific room.', 'global_topic', 'public', 'open', 'all_members', '{}'::jsonb)
ON CONFLICT ("room_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "visibility" "story_visibility" DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "media_upload_ref" uuid;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_media_upload_ref_uploads_upload_id_fk" FOREIGN KEY ("media_upload_ref") REFERENCES "public"."uploads"("upload_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "canonical_public_story_id" uuid;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_canonical_public_story_id_stories_story_id_fk" FOREIGN KEY ("canonical_public_story_id") REFERENCES "public"."stories"("story_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stories_room_created_idx" ON "stories" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "stories_visibility_lifecycle_idx" ON "stories" USING btree ("visibility","lifecycle_state");--> statement-breakpoint
CREATE UNIQUE INDEX "stories_media_upload_ref_uq" ON "stories" USING btree ("media_upload_ref") WHERE "media_upload_ref" is not null;
