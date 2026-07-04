-- WS-U.3.3b — durable platform-floor freeze for a room's AI agent (SPEC §16.6/
-- §24.6). Adds a `floor_frozen` flag to the room agent binding, DISTINCT from
-- `active`: it is set ONLY by the WS-J-gated platform-floor freeze and cleared
-- ONLY by the floor unfreeze. A member ratification may flip `active` (adopt a new
-- model) but must never clear `floor_frozen`, so a community vote can never
-- re-activate a floor-frozen agent — the platform legal floor stays
-- non-overridable. Existing bindings default to not-frozen (they predate the flag).
ALTER TABLE "knomosis"."room_agent_binding" ADD COLUMN "floor_frozen" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Preserve pre-migration paused state: before this column existed the ONLY way a
-- binding became inactive was a platform-floor freeze (approveModel always set
-- active=true; the old freezeAgent set active=false). Backfill every currently
-- INACTIVE binding as floor-frozen, so a member re-ratification cannot reactivate
-- an agent the platform floor had already paused (the non-overridable floor).
UPDATE "knomosis"."room_agent_binding" SET "floor_frozen" = true WHERE "active" = false;
