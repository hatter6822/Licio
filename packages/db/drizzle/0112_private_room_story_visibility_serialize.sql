-- WS-Q — 0110's two guards did not actually serialize against each other.
--
-- THE STORY TRIGGER READ THE ROOM WITHOUT A CONFLICTING LOCK, so the pair was one
-- guard checked twice.  Under READ COMMITTED: T1 inserts a public story (its
-- trigger reads room = public and is satisfied), T2 flips the room private (its
-- trigger scans for public stories and cannot see T1's uncommitted row), and BOTH
-- commit — recreating exactly the public-story-in-a-private-room state the pair
-- exists to prevent, and which the Gate-19 re-publisher can expose.  Measured:
-- without the lock, two concurrent transactions commit with ZERO errors and leave
-- a private room holding a public story.
--
-- `FOR SHARE` on the room row fixes it in both arrival orders.  A room UPDATE takes
-- an exclusive row lock, so whichever transaction arrives second blocks and then
-- re-reads the committed state — and refuses.
--
-- AND THE TRIGGER NOW FIRES ONLY ON A TRANSITION INTO public (insert, a widen, or
-- a move between rooms) rather than on every update of a public row.  0110's
-- backfill deliberately skips a story whose canonical URL collides with an in-room
-- twin, so a stranded public row can survive it — and firing on every update meant
-- a steward could not retitle such a story and, worse, could not HIDE it, since
-- setting `hidden_state` is an update of a row whose visibility is still `public`.
-- A guard that blocks its own remediation is not a guard.  The pair still covers
-- every path: nothing becomes public inside a private room, and no room becomes
-- private while a public story remains.
--
-- (The collision-safe backfill lives in 0110 itself, not here.  It has to: an
-- aborting statement in 0110 stops the whole chain, so a follow-up written to
-- repair it would never run on the installations that needed it.)

CREATE OR REPLACE FUNCTION "enforce_story_room_visibility"() RETURNS trigger AS $$
DECLARE room_vis text;
BEGIN
  IF NEW."visibility" <> 'public' THEN
    RETURN NEW;
  END IF;
  -- Only a TRANSITION into public, so a row already public (including one this
  -- migration could not convert) stays editable and, above all, hideable.
  IF TG_OP = 'UPDATE'
     AND OLD."visibility" = 'public'
     AND OLD."room_id" = NEW."room_id" THEN
    RETURN NEW;
  END IF;
  -- FOR SHARE: conflicts with the exclusive row lock a `rooms` UPDATE takes, so a
  -- concurrent privatisation cannot interleave with this check.
  SELECT "visibility"::text INTO room_vis FROM "rooms"
    WHERE "room_id" = NEW."room_id" FOR SHARE;
  -- A story whose room is not present is a different defect (the FK covers it);
  -- do not invent a second opinion about it here.
  IF room_vis = 'private' THEN
    RAISE EXCEPTION 'story % cannot be public: room % is private', NEW."story_id", NEW."room_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
