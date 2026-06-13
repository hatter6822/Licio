-- WS-Q.1.4b — stories BACKFILL + the NOT NULL contract.
--
-- ONLINE-ROLLOUT GUARD: this runs ONLY after the WS-Q.2.1c dual-write deploy is
-- live on every API instance (see "Deploy ordering" in
-- docs/planning/18-content-and-room-model.md). Until then an old instance could
-- insert a NULL room_id and either fail the new constraint or re-introduce a
-- NULL row after the backfill.
--
-- The UPDATEs are written idempotently (room_id IS NULL / visibility filters) so
-- a straggler row is caught by re-running before SET NOT NULL. On a very large
-- table a production runner should execute this migration with per-migration
-- autocommit and a keyset batch loop; drizzle's chain runner (used by the gated
-- integration tests on a fresh, empty DB) applies it as a single statement.

-- (1) room_id: the story's branch-0 thread's room, else the Commons room.
UPDATE "stories"
SET "room_id" = COALESCE(
  (SELECT "t"."room_id" FROM "threads" "t" WHERE "t"."story_id" = "stories"."story_id" AND "t"."branch_index" = 0 LIMIT 1),
  'c0000000-0000-4000-8000-000000000000'
)
WHERE "room_id" IS NULL;--> statement-breakpoint
-- (2) visibility: room_only for every story whose (post-0014) home room is
--     private; all others keep the 'public' default (no item gains reach; no
--     publicly-visible item disappears — the monotonic-visibility property).
UPDATE "stories"
SET "visibility" = 'room_only'
FROM "rooms"
WHERE "stories"."room_id" = "rooms"."room_id"
  AND "rooms"."visibility" = 'private'
  AND "stories"."visibility" <> 'room_only';--> statement-breakpoint
-- (3) The contract: every content item now has a home room.
ALTER TABLE "stories" ALTER COLUMN "room_id" SET NOT NULL;
