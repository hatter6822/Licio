-- WS-S.1.3b / §8.3 — the DATABASE GUARD: NO server table may accumulate rows
-- for a Private P2P room.  §8.3 requires that "every server table or store that
-- can reference a room MUST reject P2P room ids unless it is a stub/rendezvous
-- table."  The service-layer guards (the submission `409`, the contribution
-- `404`, the ranking/search/event exclusions) are the primary enforcement, but
-- this BEFORE INSERT/UPDATE trigger is the deepest, code-path-independent
-- defense: it rejects any row whose `room_id` resolves to `storage_mode = 'p2p'`.
--
-- Coverage = EVERY room-referencing table EXCEPT the §8.2 allowlisted
-- `private_room_stubs` (whose `room_server_id` is the legitimate shell ⇄ room
-- link) and `private_rendezvous_records` (which has no room column at all):
--   • `stories` + `threads` — the ROOTS of server content (a contribution needs
--     a thread, an upload a story), so this transitively forbids every
--     downstream content row (contributions, uploads, summaries);
--   • `room_stewards` — a P2P room's authority is room-keys only (§11.4); it can
--     have NO platform steward;
--   • `room_subscriptions` — a P2P room is client-synced; it has no server-side
--     membership/notification rows;
--   • `lenses` — a P2P room's content is not on the server, so a server-side
--     interpretive overlay is meaningless.
-- A NULL/absent room (the SELECT finds nothing) leaves `room_storage` NULL, so
-- `NULL = 'p2p'` is not true and the row is allowed — the guard only ever bites
-- a real p2p room (server rooms are unaffected).  Mirrors the
-- `enforce_thread_room_consistency` trigger pattern (migration 0018).
CREATE OR REPLACE FUNCTION "enforce_no_p2p_room_content"() RETURNS trigger AS $$
DECLARE room_storage room_storage_mode;
BEGIN
  SELECT "storage_mode" INTO room_storage FROM "rooms" WHERE "room_id" = NEW."room_id";
  IF room_storage = 'p2p' THEN
    RAISE EXCEPTION 'server content in % cannot reference Private P2P room %', TG_TABLE_NAME, NEW."room_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "stories_no_p2p_room"
  BEFORE INSERT OR UPDATE ON "stories"
  FOR EACH ROW EXECUTE FUNCTION "enforce_no_p2p_room_content"();--> statement-breakpoint
CREATE TRIGGER "threads_no_p2p_room"
  BEFORE INSERT OR UPDATE ON "threads"
  FOR EACH ROW EXECUTE FUNCTION "enforce_no_p2p_room_content"();--> statement-breakpoint
CREATE TRIGGER "room_stewards_no_p2p_room"
  BEFORE INSERT OR UPDATE ON "room_stewards"
  FOR EACH ROW EXECUTE FUNCTION "enforce_no_p2p_room_content"();--> statement-breakpoint
CREATE TRIGGER "room_subscriptions_no_p2p_room"
  BEFORE INSERT OR UPDATE ON "room_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION "enforce_no_p2p_room_content"();--> statement-breakpoint
CREATE TRIGGER "lenses_no_p2p_room"
  BEFORE INSERT OR UPDATE ON "lenses"
  FOR EACH ROW EXECUTE FUNCTION "enforce_no_p2p_room_content"();
