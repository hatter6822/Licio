-- WS-G.2.2 — the member's chosen POSTING lens for a room: the interpretation a
-- top-level comment they write joins.  NULL is the default "Undecided" state
-- present in every room (it is the null state, so it can never be absent).  The
-- lens is set when a member joins and changed only through the room's lens
-- control (never the reading/filter lens).  ON DELETE SET NULL returns a lens's
-- members to Undecided when a steward removes that lens.
ALTER TABLE "room_subscriptions" ADD COLUMN "lens_id" uuid;--> statement-breakpoint
ALTER TABLE "room_subscriptions" ADD CONSTRAINT "room_subscriptions_lens_id_lenses_lens_id_fk" FOREIGN KEY ("lens_id") REFERENCES "public"."lenses"("lens_id") ON DELETE set null ON UPDATE no action;
