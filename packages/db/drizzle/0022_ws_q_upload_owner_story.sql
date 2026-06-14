-- WS-Q.5.2c — back-reference media uploads to their owning story so the gated
-- serving path (`GET /v1/uploads/:id`) can re-derive each upload's visibility (a
-- room_only story requires a short-lived signed read URL) and re-check takedown
-- at fetch time. Additive and nullable (contribution attachments stay null and
-- keep their existing serving behaviour). The FK is ON DELETE SET NULL and added
-- NOT VALID then VALIDATEd so an existing table is not fully locked.
ALTER TABLE "uploads" ADD COLUMN "owner_story_id" uuid;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_owner_story_id_stories_story_id_fk" FOREIGN KEY ("owner_story_id") REFERENCES "public"."stories"("story_id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "uploads" VALIDATE CONSTRAINT "uploads_owner_story_id_stories_story_id_fk";--> statement-breakpoint
CREATE INDEX "uploads_owner_story_idx" ON "uploads" USING btree ("owner_story_id");
