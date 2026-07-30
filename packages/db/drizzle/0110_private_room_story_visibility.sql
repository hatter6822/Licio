-- WS-Q — a PUBLIC story cannot live in a PRIVATE room, enforced by Postgres.
--
-- `stories.visibility`'s own comment says "a private room forces `room_only`",
-- and nothing enforced it.  The invariant was maintained by the application
-- cascade alone, which cannot hold it: `changeRoomVisibility` converts the
-- room's public stories, does a final uncursored straggler pass, and THEN flips
-- the room — so anything that becomes public after that last read is never
-- revisited.  Two writer paths reach it, and both read the room's visibility
-- long before they write the story:
--
--   • a fresh submission (`POST /v1/stories`) whose `deriveStoryVisibility` saw
--     the room still public.  A first-time link, or any inline/image/video post,
--     has `canonical_url IS NULL` and so trips no tier-unique index either — it
--     is silently left public;
--   • an author widen (`changeStoryVisibility(..., 'public')`), which reads the
--     room and then awaits two more queries before writing.  Its `created_at` is
--     old, so it is not even a "straggler above the cursor".
--
-- The leftover row is not cosmetic.  The Gate-19 public re-publisher derives
-- eligibility from room STORAGE MODE plus story visibility and never reads room
-- visibility, so a public story left in a private room is publishable to the
-- public IPFS DHT.  (Feed exposure is separately contained — the WS-I retriever
-- requires a public home room.)
--
-- Enforced from BOTH sides, because either alone leaves a window:
--   1. writing a public story into a private room is refused;
--   2. taking a room private while a public story remains is refused — which is
--      what makes the cascade's own race safe.  A straggler that appeared after
--      the last read now fails the flip instead of surviving it, and the cascade
--      already answers that condition with a 409 naming the blockers.
--
-- Follows `enforce_thread_room_consistency` (0018) and
-- `enforce_no_p2p_room_content` (0045): the same BEFORE-trigger shape, the same
-- `check_violation` errcode.
--
-- The backfill runs FIRST.  A trigger installed over violating rows lets them sit
-- unnoticed until some unrelated update touches them, and this repo's precedent
-- (0076) is to repair stored data rather than leave rows the code cannot process.
UPDATE "stories" SET "visibility" = 'room_only'
WHERE "visibility" = 'public'
  AND "room_id" IN (SELECT "room_id" FROM "rooms" WHERE "visibility" = 'private');--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_story_room_visibility"() RETURNS trigger AS $$
DECLARE room_vis text;
BEGIN
  IF NEW."visibility" <> 'public' THEN
    RETURN NEW;
  END IF;
  SELECT "visibility"::text INTO room_vis FROM "rooms" WHERE "room_id" = NEW."room_id";
  -- A story whose room is not present is a different defect (the FK covers it);
  -- do not invent a second opinion about it here.
  IF room_vis = 'private' THEN
    RAISE EXCEPTION 'story % cannot be public: room % is private', NEW."story_id", NEW."room_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "stories_room_visibility"
  BEFORE INSERT OR UPDATE ON "stories"
  FOR EACH ROW EXECUTE FUNCTION "enforce_story_room_visibility"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_room_visibility_no_public_stories"() RETURNS trigger AS $$
DECLARE leftover uuid;
BEGIN
  IF NEW."visibility" <> 'private' OR OLD."visibility" = 'private' THEN
    RETURN NEW;
  END IF;
  SELECT "story_id" INTO leftover FROM "stories"
    WHERE "room_id" = NEW."room_id" AND "visibility" = 'public' LIMIT 1;
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'room % cannot go private: story % is still public', NEW."room_id", leftover
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "rooms_visibility_no_public_stories"
  BEFORE UPDATE ON "rooms"
  FOR EACH ROW EXECUTE FUNCTION "enforce_room_visibility_no_public_stories"();
