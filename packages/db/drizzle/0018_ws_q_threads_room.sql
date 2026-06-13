-- WS-Q.1.5 — threads: denormalize the room from the owning story, make it NOT
-- NULL, and add a programming-error guard that the two never diverge.
--
-- A thread's room ALWAYS equals its story's room (story room moves are out of v1
-- scope and documented). The backfill overwrites any divergent/NULL room before
-- the constraint + trigger land, so the chain is self-consistent.
UPDATE "threads"
SET "room_id" = "s"."room_id"
FROM "stories" "s"
WHERE "threads"."story_id" = "s"."story_id"
  AND ("threads"."room_id" IS NULL OR "threads"."room_id" <> "s"."room_id");--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "room_id" SET NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_thread_room_consistency"() RETURNS trigger AS $$
DECLARE story_room uuid;
BEGIN
  SELECT "room_id" INTO story_room FROM "stories" WHERE "story_id" = NEW."story_id";
  IF story_room IS NULL THEN
    RAISE EXCEPTION 'thread % references story % which has no room', NEW."thread_id", NEW."story_id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."room_id" <> story_room THEN
    RAISE EXCEPTION 'thread room (%) must equal its story room (%)', NEW."room_id", story_room USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "threads_room_consistency"
  BEFORE INSERT OR UPDATE ON "threads"
  FOR EACH ROW EXECUTE FUNCTION "enforce_thread_room_consistency"();
