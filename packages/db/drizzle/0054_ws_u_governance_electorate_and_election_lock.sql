-- WS-U governance correctness (M4 + L4).
--
-- M4 — freeze the ratification turnout electorate at open. `min_quorum` is already
-- snapshotted at open; adding `eligible_count` (the FROZEN turnout denominator)
-- makes the whole adoption bound fixed for the life of the vote, so membership
-- churn between open and the settle tick can no longer flip the outcome by
-- shrinking the denominator. Existing rows default to 0.
ALTER TABLE "knomosis"."model_ratification" ADD COLUMN "eligible_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill the frozen electorate for any ALREADY-OPEN ratification from current
-- ACTIVE room membership, so the new frozen-denominator settle path does not
-- mis-reject an in-flight vote (which would otherwise inherit eligible_count=0 and
-- compute 0 turnout under a law-pack with minTurnout > 0).
UPDATE "knomosis"."model_ratification" mr
SET "eligible_count" = (
  SELECT count(*)::int
  FROM "public"."room_subscriptions" rs
  WHERE rs."room_id" = mr."room_id" AND rs."status" = 'active'
)
WHERE mr."status" = 'open';--> statement-breakpoint
-- L4 — at most ONE open steward election per room (mirrors the ratification guard).
-- A second concurrent open collides on this partial unique index rather than
-- racing a read-then-write, so the scheduler can never seat two winners for one
-- room. Defensively cancel any PRE-EXISTING duplicate open elections per room
-- (keeping the earliest) first, so a historical duplicate cannot abort the index
-- creation and block deployment.
UPDATE "knomosis"."steward_election" SET "status" = 'cancelled'
WHERE "status" = 'open' AND "election_id" NOT IN (
  SELECT DISTINCT ON ("room_id") "election_id"
  FROM "knomosis"."steward_election"
  WHERE "status" = 'open'
  ORDER BY "room_id", "created_at" ASC
);--> statement-breakpoint
-- Repoint any seat whose current_election_id referenced a duplicate just cancelled
-- above to the KEPT open election for its room, so no seat is left pointing at a
-- cancelled election (which runElectionLifecycle could not settle, orphaning the
-- kept-open election and leaving the room unable to progress).
UPDATE "knomosis"."room_steward_seat" s
SET "current_election_id" = (
  SELECT e."election_id" FROM "knomosis"."steward_election" e
  WHERE e."room_id" = s."room_id" AND e."status" = 'open'
  ORDER BY e."created_at" ASC LIMIT 1
)
WHERE s."current_election_id" IS NOT NULL
  AND s."current_election_id" NOT IN (
    SELECT "election_id" FROM "knomosis"."steward_election" WHERE "status" = 'open'
  );--> statement-breakpoint
CREATE UNIQUE INDEX "steward_election_one_open_per_room" ON "knomosis"."steward_election" USING btree ("room_id") WHERE "knomosis"."steward_election"."status" = 'open';
