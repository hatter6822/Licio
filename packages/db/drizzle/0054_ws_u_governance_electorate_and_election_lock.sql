-- WS-U governance correctness (M4 + L4).
--
-- M4 — freeze the ratification turnout electorate at open. `min_quorum` is already
-- snapshotted at open; adding `eligible_count` (the FROZEN turnout denominator)
-- makes the whole adoption bound fixed for the life of the vote, so membership
-- churn between open and the settle tick can no longer flip the outcome by
-- shrinking the denominator. Existing rows default to 0.
ALTER TABLE "knomosis"."model_ratification" ADD COLUMN "eligible_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- L4 — at most ONE open steward election per room (mirrors the ratification guard).
-- A second concurrent open collides on this partial unique index rather than
-- racing a read-then-write, so the scheduler can never seat two winners for one
-- room.
CREATE UNIQUE INDEX "steward_election_one_open_per_room" ON "knomosis"."steward_election" USING btree ("room_id") WHERE "knomosis"."steward_election"."status" = 'open';
