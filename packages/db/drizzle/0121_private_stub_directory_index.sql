-- WS-S §4.2 — indexes for the two reads that page `private_room_stubs`.
--
-- The public directory read is UNAUTHENTICATED and budgeted at 300 requests a
-- minute, and `LIMIT` bounds the ROWS RETURNED, not the work: without a
-- supporting index the planner filters `directory_mode = 'listed'` and sorts by
-- `(created_at, stub_id)` across every listed row on each request.  A table with
-- a primary key and a room-id unique is not indexed for the query the endpoint
-- actually runs.
--
-- PARTIAL on `listed`, because that is the only mode the directory can serve —
-- an `unlisted` stub has no business occupying it, and keeping it out also keeps
-- the index proportional to what is public rather than to what exists.
--
-- The second index serves the two OWNER reads: the Art. 15 export and the
-- create-recovery lookup, both keyed on `created_by_account_id`.

CREATE INDEX IF NOT EXISTS "private_room_stubs_directory_idx"
  ON "private_room_stubs" ("created_at" DESC, "stub_id" DESC)
  WHERE "directory_mode" = 'listed';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "private_room_stubs_account_idx"
  ON "private_room_stubs" ("created_by_account_id", "created_at" DESC);
