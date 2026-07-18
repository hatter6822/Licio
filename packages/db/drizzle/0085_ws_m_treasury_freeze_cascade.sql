-- WS-M.2.4a (PR #144 review, wave 10): a STRUCTURAL cascade marker on the
-- treasury freeze.
--
-- A room-scope freeze cascades onto the treasury; lifting the room freeze
-- must clear ONLY that cascade, never an independent treasury-scope hold.
-- The previous discriminator compared the free-form member-visible reason
-- text, so an independent hold sharing common wording ("pending review")
-- would be lifted with the room.  The boolean marker records provenance
-- explicitly and is reset on every unfreeze.
ALTER TABLE "knomosis"."room_treasury"
  ADD COLUMN IF NOT EXISTS "freeze_cascaded" boolean NOT NULL DEFAULT false;
