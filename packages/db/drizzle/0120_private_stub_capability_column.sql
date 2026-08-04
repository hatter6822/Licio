-- WS-S §8.2/§21.2 — take the bootstrap capability OUT of the signed stub body.
--
-- `signed_stub`'s own schema comment says "public fields only", and it carried
-- `bootstrap_blind_id`: the token that gates every `unlisted` bootstrap read.
-- A jsonb blob is projected wholesale or not at all, so the secret rode every
-- projection of that blob — including the OPEN read a `listed` room serves.
-- With the §4.2 directory enumerating listed room ids, that is a harvest: one
-- anonymous GET per listed room yields a token that keeps resolving the record
-- after the creator delists it, which is exactly the state delisting exists to
-- prevent.
--
-- Gating the projection would have fixed the leak that was found. Moving the
-- capability into its own column fixes the ones that were not: a column is
-- named in the §8.2 allowlist, is absent from every response type by
-- construction, and cannot be re-leaked by the next endpoint that decides to
-- return the signed body.
--
-- EXISTING RECORDS ARE PRESERVED, and this is the part that needed care.
--
-- The signature covers the canonical bytes of the ORIGINAL body, and the server
-- holds no room key — so it cannot re-sign, and rewriting the body in place
-- would leave every migrated record serving a pair that cannot verify. An
-- earlier cut of this migration DELETED those rows instead. That was worse: a
-- room whose founder device is gone could never register again (the capability
-- derives from the epoch-0 key), outstanding invites keep the old server id,
-- and existing members keep a handle to nothing.
--
-- So the body is left EXACTLY as it was signed, and the capability is copied
-- into its own column. A v1 body still contains the token, so the read path
-- withholds that body from a caller who did not present the capability —
-- `signed_stub` is served to a token-holder, who already has it, and omitted
-- from the open `listed` read that was the harvest. New records are v2 and
-- carry no secret, so they are served to everyone.
--
-- Identity, capability and verifiability all survive; only the leak closes.

ALTER TABLE "private_room_stubs"
  ADD COLUMN "bootstrap_blind_id" text;
--> statement-breakpoint

UPDATE "private_room_stubs"
  SET "bootstrap_blind_id" = "signed_stub" ->> 'bootstrap_blind_id'
  WHERE "signed_stub" ? 'bootstrap_blind_id';
--> statement-breakpoint

-- A row whose body carries no token has no capability at ALL: `unlisted`
-- members cannot resolve it and a `listed` one becomes unresolvable the moment
-- it is delisted. It is already dead, and the value derives from an epoch-0 key
-- the server has never held, so there is nothing to preserve. Deleting the
-- SHELL cascades its stub — an orphaned shell would keep asserting "this
-- account created a private room at time T" with nothing able to find it.
DELETE FROM "rooms"
  WHERE "room_id" IN (
    SELECT "room_server_id" FROM "private_room_stubs" WHERE "bootstrap_blind_id" IS NULL
  );
--> statement-breakpoint

-- NOT NULL: a stub without a capability cannot be constructed, which is the
-- guarantee §21.4's "delisting keeps the record resolvable" rests on.
ALTER TABLE "private_room_stubs"
  ALTER COLUMN "bootstrap_blind_id" SET NOT NULL;
--> statement-breakpoint

-- TRUNCATE preserved timestamps to milliseconds, which is the resolution the
-- cursors carry.
--
-- Postgres stores microseconds and `defaultNow()` produced them; the directory
-- and owner keyset cursors serialize through `Date.toISOString()`, which is
-- millisecond-resolution. A cursor built from a row at `…001500` compares as
-- `…001000`, so a following row in the same millisecond is neither `<` nor `=`
-- and is skipped — silently, and in both the paged `/mine` read and the DSAR
-- export that iterates it, which is the one place a skipped row is a compliance
-- failure rather than a display bug. New inserts already write an explicit
-- millisecond value; this brings the preserved rows into the same resolution.
UPDATE "private_room_stubs"
  SET "created_at" = date_trunc('milliseconds', "created_at"),
      "updated_at" = date_trunc('milliseconds', "updated_at")
  WHERE "created_at" <> date_trunc('milliseconds', "created_at")
     OR "updated_at" <> date_trunc('milliseconds', "updated_at");
