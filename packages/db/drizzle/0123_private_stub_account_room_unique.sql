-- WS-S §21.1 — one directory record per account per ROOM.
--
-- Registration read "is there one already?" and then created, which is a
-- check-then-act across two statements: two tabs, or a retry overlapping a
-- still-running POST, both see nothing and both insert.  The result is a
-- duplicate that the recovery lookup picks between arbitrarily and an orphan
-- that stays publicly enumerable if its mode was `listed`.
--
-- `room_public_key` is the room's founder signing key, so `(created_by_account_id,
-- room_public_key)` is exactly "this account, this room".  The create path
-- adopts the existing row on conflict rather than failing, which is what makes
-- the retry idempotent rather than merely refused.
--
-- Existing duplicates are collapsed first — oldest kept, since that is the one
-- outstanding invites and any stored handle already point at.  Deleting the
-- SHELL cascades its stub.

DELETE FROM "rooms"
  WHERE "room_id" IN (
    SELECT "room_server_id" FROM (
      SELECT
        "room_server_id",
        row_number() OVER (
          PARTITION BY "created_by_account_id", "room_public_key"
          ORDER BY "created_at", "stub_id"
        ) AS "rn"
      FROM "private_room_stubs"
      WHERE "created_by_account_id" IS NOT NULL
    ) AS "ranked"
    WHERE "ranked"."rn" > 1
  );
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "private_room_stubs_account_room_uq"
  ON "private_room_stubs" ("created_by_account_id", "room_public_key");
