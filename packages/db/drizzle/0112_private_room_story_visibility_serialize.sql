-- WS-Q — two defects in migration 0110's own guards, found in review of it.
--
-- 1. THE STORY TRIGGER READ THE ROOM WITHOUT A CONFLICTING LOCK, so the pair of
--    triggers did not actually serialize against each other.  Under READ
--    COMMITTED: T1 inserts a public story (its trigger reads room = public and
--    is satisfied), T2 flips the room private (its trigger scans for public
--    stories and cannot see T1's uncommitted row), and BOTH commit — recreating
--    exactly the public-story-in-a-private-room state the migration exists to
--    prevent, and which the Gate-19 re-publisher can expose.  Two guards that
--    each check the other's subject need a lock, or they are one guard checked
--    twice.
--
--    `FOR SHARE` on the room row fixes it in both orders.  A room UPDATE takes an
--    exclusive row lock, so whichever transaction arrives second blocks and then
--    re-reads the committed state — and refuses.
--
-- 2. THE BACKFILL COULD ABORT THE WHOLE MIGRATION.  A private room may
--    legitimately hold BOTH a public story and a `room_only` story for the same
--    canonical URL — `ingestion/submission.ts` records that cross-tier pair on
--    purpose, and the two partial uniques permit it.  Converting the public copy
--    then moves it into an occupied `(canonical_url, room_id)` slot and raises
--    23505, so 0110 aborted BEFORE installing either trigger, on precisely the
--    installations whose inconsistent rows it was written to repair.  Total
--    failure to protect anything, on the only databases that needed it.
--
--    Converted rows are now limited to those that CAN convert, and the remainder
--    is reported with `RAISE NOTICE` (the `@licio/db` client projects notices
--    through pino, so an operator sees it) rather than taking the migration down.
--    There is no correct automatic resolution for such a pair: the room_only twin
--    already carries that URL in-room, `story_hidden_state` has only `takedown`
--    and `safety` — neither of which means "duplicate" — and deleting a story in
--    a migration is not this file's decision.  The live cascade answers the same
--    condition with a 409 that NAMES the blockers for a steward, which is the
--    right shape for a judgement call.
--
-- Because of (2) a stranded row can still exist after this runs, so the story
-- trigger fires only on a TRANSITION INTO public (insert, a widen, or a move
-- between rooms) rather than on every update of a public row.  Otherwise a
-- steward could not so much as retitle a stranded story — and, worse, could not
-- HIDE it, since setting `hidden_state` is an update of a row whose visibility is
-- still `public`.  A guard that blocks its own remediation is not a guard.  The
-- pair still covers every path: nothing can become public inside a private room,
-- and no room can become private while a public story remains.

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

-- The remaining repair: convert the stranded rows 0110 may not have reached
-- (its own UPDATE aborted on the first collision, so on an affected installation
-- NONE of them were converted).  Idempotent.
UPDATE "stories" AS s SET "visibility" = 'room_only'
WHERE s."visibility" = 'public'
  AND s."room_id" IN (SELECT "room_id" FROM "rooms" WHERE "visibility" = 'private')
  AND (
    -- Not in the destination index at all ⇒ cannot collide.
    s."canonical_url" IS NULL
    OR s."hidden_state" IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM "stories" t
      WHERE t."room_id" = s."room_id"
        AND t."canonical_url" = s."canonical_url"
        AND t."visibility" = 'room_only'
        AND t."hidden_state" IS NULL
        AND t."story_id" <> s."story_id"
    )
  );--> statement-breakpoint

DO $$
DECLARE stranded bigint;
BEGIN
  SELECT count(*) INTO stranded FROM "stories" s
    WHERE s."visibility" = 'public'
      AND s."room_id" IN (SELECT "room_id" FROM "rooms" WHERE "visibility" = 'private');
  IF stranded > 0 THEN
    RAISE NOTICE 'WS-Q: % public story(ies) remain in private rooms — each shares a canonical URL with an in-room twin, so converting it would violate stories_canonical_url_room_uq. Resolve the duplicate (hide or remove one copy), then re-run this statement.', stranded;
  END IF;
END $$;
