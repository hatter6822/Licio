-- WS-Q — finish migration 0110: repair the public stories it had to leave in private rooms.
--
-- 0110 converts public stories in private rooms to `room_only` and could not convert one
-- case: a story sharing a canonical URL with an in-room `room_only` twin, where the
-- conversion lands in an occupied `(canonical_url, room_id)` slot and raises 23505.  It
-- skipped those rows and RAISEd a NOTICE with a count.
--
-- The count was a live leak, not a note.  Each such row is a PUBLIC story inside a
-- PRIVATE room, and the Gate-19 public re-publisher derives eligibility from room storage
-- mode plus story visibility while never reading room visibility — so every one of them
-- is publishable to the public IPFS DHT.  That is the condition 0110 was written to close,
-- left open on exactly the installations that had it.
--
-- The resolution 0110 said did not exist is to HIDE the duplicate.  Both tier uniques are
-- PARTIAL on `hidden_state IS NULL`, so a hidden row is outside the index and the
-- collision is gone — the same mechanism `submission.ts` already relies on for a
-- scan-held story.  Nothing is deleted: the row keeps its history and its author, and the
-- URL stays served by the twin that already carries it in-room.
--
-- What it is hidden AS needed a new value.  `takedown` is a legal instrument.  `safety` is
-- moderation's hide, and `setStoryHiddenState` LIFTS exactly `safety` on reinstatement —
-- so a duplicate marked `safety` would be un-hidden by a steward acting on an unrelated
-- reinstate, re-entering the URL slot it was moved out of.  Both would also record a
-- reason that never happened, in the surface a steward reads to learn why an item is not
-- visible.  `superseded` says what is true, and is deliberately not liftable by that path.
--
-- WHY A TYPE SWAP RATHER THAN `ALTER TYPE … ADD VALUE`:
--
-- Postgres refuses to USE a new enum label in the transaction that added it, and the
-- Drizzle migrator runs the pending batch as ONE transaction — so splitting the ADD VALUE
-- and the repair into two migration files does not separate them.  Verified the hard way:
-- as two files this failed with `unsafe use of new value "superseded" of enum type`, and
-- it would have failed on a FRESH database too, where the repair matches no rows at all —
-- the restriction fires at plan time, not on the rows touched.  It would have broken the
-- whole chain for every installation.
--
-- The documented exception is a type CREATED in the same transaction, which is what this
-- does: build the type, move the column onto it, retire the old name.  Exactly one column
-- and no function depends on `story_hidden_state`, so the swap is contained.
CREATE TYPE "story_hidden_state_next" AS ENUM('takedown', 'safety', 'superseded');
--> statement-breakpoint
ALTER TABLE "stories"
  ALTER COLUMN "hidden_state" TYPE "story_hidden_state_next"
  USING "hidden_state"::text::"story_hidden_state_next";
--> statement-breakpoint
DROP TYPE "story_hidden_state";
--> statement-breakpoint
ALTER TYPE "story_hidden_state_next" RENAME TO "story_hidden_state";
--> statement-breakpoint

-- Both columns move in ONE statement.  Split across two, the row would be momentarily
-- `room_only` and not yet hidden (or hidden and still public), and either the tier unique
-- or the 0110 trigger would refuse the intermediate state.
-- EVERY stranded row, not only the unhidden ones.
--
-- A public story in a private room that is ALREADY hidden — a `takedown`, or a moderation
-- `safety` hide — is not a publish leak (`fromStory` needs `hiddenState === null` to
-- publish), but it is still the WS-Q violation this migration exists to end, and the 0110
-- trigger will refuse any later update that leaves it public.  Skipping it also left the
-- assertion below counting a row the repair had declined to touch, which halts the
-- migration chain permanently on any installation that has one.
--
-- `COALESCE` keeps the stronger reason where one exists: a takedown stays a takedown and
-- merely becomes room_only, while an unhidden duplicate becomes `superseded`.  Hiding
-- either way takes the row out of the tier uniques, which are partial on
-- `hidden_state IS NULL`, so no conversion can collide.
UPDATE "stories" AS s
   SET "visibility" = 'room_only',
       "hidden_state" = COALESCE(s."hidden_state", 'superseded')
 WHERE s."visibility" = 'public'
   AND s."room_id" IN (SELECT "room_id" FROM "rooms" WHERE "visibility" = 'private');
--> statement-breakpoint

-- Assert, rather than report a count a second time.  The condition is a live
-- publish-eligibility leak, and a NOTICE on a migration nobody watches is how it survived
-- the first time.  No legitimate residue remains for this to trip on: a row that was
-- already hidden was never in the index, and one that was not is repaired above.
DO $$
DECLARE stranded bigint;
BEGIN
  SELECT count(*) INTO stranded FROM "stories" s
    WHERE s."visibility" = 'public'
      AND s."room_id" IN (SELECT "room_id" FROM "rooms" WHERE "visibility" = 'private');
  IF stranded > 0 THEN
    RAISE EXCEPTION 'WS-Q: % public story(ies) still in private rooms after the repair - each is publishable to the public IPFS DHT by the Gate-19 re-publisher. Migration halted deliberately.', stranded;
  END IF;
END $$;
