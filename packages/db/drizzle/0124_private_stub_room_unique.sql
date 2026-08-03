-- WS-S §21.1 — one directory record per ROOM, not per account.
--
-- Migration 0123 made the key `(created_by_account_id, room_public_key)`,
-- which answers "may this ACCOUNT register this room twice" — and the room's
-- record is not an account's possession.  Its `room_server_id` is the handle
-- every invite carries and the value the §4.2 directory publishes, so a second
-- record for the same room lists that room twice, under two ids, with two
-- bootstrap capabilities; a member who resolves the wrong one reaches a shell
-- no other member is using, and delisting the one nobody sees leaves the other
-- advertised.
--
-- It was reachable without any race: a founder DEVICE signed into a second
-- account (the same device holds the epoch-0 key, and the panel offered
-- registration whenever the signed-in account owned no record) inserted a
-- second row for the same room, because the account column made the key
-- different.
--
-- `room_public_key` alone is the room's identity — it is the founder signing
-- key the record is verified against.  The service now refuses a registration
-- for a room another account already registered (`room_already_registered`,
-- 409) and still ADOPTS the caller's own row, which is what keeps a retry or a
-- second tab idempotent.  This index is the backstop for both.
--
-- Existing duplicates are collapsed first — oldest kept, since that is the one
-- outstanding invites and any stored handle already point at.  Deleting the
-- SHELL cascades its stub.  (The name is `…_room_key_uq`: `…_room_uq` is
-- already taken by the one-stub-per-SHELL index on `room_server_id`.)

DELETE FROM "rooms"
  WHERE "room_id" IN (
    SELECT "room_server_id" FROM (
      SELECT
        "room_server_id",
        row_number() OVER (
          PARTITION BY "room_public_key"
          ORDER BY "created_at", "stub_id"
        ) AS "rn"
      FROM "private_room_stubs"
    ) AS "ranked"
    WHERE "ranked"."rn" > 1
  );
--> statement-breakpoint

DROP INDEX IF EXISTS "private_room_stubs_account_room_uq";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "private_room_stubs_room_key_uq"
  ON "private_room_stubs" ("room_public_key");
