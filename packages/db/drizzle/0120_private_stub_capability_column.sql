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

-- MIGRATING A ROW IN PLACE IS NOT POSSIBLE, and pretending otherwise is worse
-- than dropping it.
--
-- `stub_signature` covers the canonical bytes of the ORIGINAL body. Lifting
-- `bootstrap_blind_id` out of that body would leave every pre-existing record
-- serving a body/signature pair that cannot verify — and carrying a v1 schema
-- tag the current reader does not accept. The server holds no room key, so it
-- cannot re-sign; only the room can, and only from a member device.
--
-- An unverifiable directory record is worse than an absent one: a member who
-- checks the signature concludes their own room's entry was forged. So the
-- pre-existing stubs are REMOVED, shell and all, and a member re-registers from
-- the room's settings — which re-signs the v2 body with the room's own key,
-- the only place that can.
--
-- The ROOM is untouched. It lives on member devices and the server never held
-- it; what goes is Licio's bootstrap record, which is what §21.4 says a delete
-- of this kind is. Deleting the shell cascades the stub (the FK runs that way
-- and not the reverse), so this single statement takes both — leaving an
-- orphaned shell would keep a row asserting "this account created a private
-- room at time T" that nothing could ever find again.
DELETE FROM "rooms"
  WHERE "room_id" IN (SELECT "room_server_id" FROM "private_room_stubs");
--> statement-breakpoint

-- The capability, as its own column: NOT NULL, so a stub without one — whose
-- members lose the record the moment it is delisted — cannot be constructed.
ALTER TABLE "private_room_stubs"
  ADD COLUMN "bootstrap_blind_id" text NOT NULL;
