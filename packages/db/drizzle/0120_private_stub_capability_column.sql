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
-- return the signed body. The blob's comment becomes true rather than aspirational.
--
-- Signing it bought nothing. The signature is verified against
-- `room_public_key`, which the signed body itself carries, so it only means
-- something to a reader who independently knows the room's key — a member, who
-- holds the token already. What the token needs is SECRECY, which a signature
-- does not provide.
--
-- NOT NULL with no default: every stub must carry a capability, or its members
-- lose the record the moment it is delisted (the create path already refused a
-- body without one — this makes the database refuse it too).

ALTER TABLE "private_room_stubs"
  ADD COLUMN "bootstrap_blind_id" text;
--> statement-breakpoint

-- Backfill from where the value used to live, then drop it from the blob so the
-- two can never disagree. Both statements are no-ops on a table with no rows.
UPDATE "private_room_stubs"
  SET "bootstrap_blind_id" = "signed_stub" ->> 'bootstrap_blind_id'
  WHERE "signed_stub" ? 'bootstrap_blind_id';
--> statement-breakpoint

-- A pre-existing row with no token in its body cannot be repaired here: the
-- value derives from the room's epoch-0 rendezvous key, which the server has
-- never held. Such a row is already unresolvable for its members, so it is
-- removed rather than blocking the migration with a NOT NULL violation — the
-- room itself is untouched, since the server never held it.
DELETE FROM "private_room_stubs" WHERE "bootstrap_blind_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "private_room_stubs"
  ALTER COLUMN "bootstrap_blind_id" SET NOT NULL;
--> statement-breakpoint

UPDATE "private_room_stubs"
  SET "signed_stub" = "signed_stub" - 'bootstrap_blind_id'
  WHERE "signed_stub" ? 'bootstrap_blind_id';
