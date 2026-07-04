-- WS-U.3.3b — durable platform-floor freeze for a room's AI agent (SPEC §16.6/
-- §24.6). Adds a `floor_frozen` flag to the room agent binding, DISTINCT from
-- `active`: it is set ONLY by the WS-J-gated platform-floor freeze and cleared
-- ONLY by the floor unfreeze. A member ratification may flip `active` (adopt a new
-- model) but must never clear `floor_frozen`, so a community vote can never
-- re-activate a floor-frozen agent — the platform legal floor stays
-- non-overridable. Existing bindings default to not-frozen (they predate the flag).
ALTER TABLE "knomosis"."room_agent_binding" ADD COLUMN "floor_frozen" boolean DEFAULT false NOT NULL;
