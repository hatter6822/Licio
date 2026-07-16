-- WS-N (PR #145 review, wave 23): ONE WS-L action per payment intent,
-- enforced at the DATABASE — the mirror of 0087.
--
-- 0087 stops two intents claiming ONE action (`payment_intent.action_record_id`
-- unique).  Nothing stopped the reverse: one intent spawning MANY actions.
-- While an intent sits `signed`, before the client attaches the first action, a
-- caller could mint a second preflight and submit the same intent again under a
-- different idempotency key -- and for a room-owned payout another steward
-- could, because the action idempotency unique is `(actor_user_id,
-- idempotency_key)` and deliberately actor-scoped (a room-wide key would let
-- one member squat another's).  Each submit reserved its own record, forwarded
-- with its own gateway key (the record id), and MOVED FUNDS; only one could
-- ever attach to the intent's ledger, so the rest settled outside the
-- accounting export.
--
-- The exclusive resource is the INTENT, so the uniqueness belongs on the
-- reference to it: a second reservation for the same intent loses this index
-- and replays the winner, whoever submitted it and whatever key they chose.
-- Partial, so the direct (intent-free) actions keep their actor-scoped key.
ALTER TABLE "knomosis"."knomosis_action_record"
  ADD COLUMN IF NOT EXISTS "payment_intent_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knomosis_action_intent_uq"
  ON "knomosis"."knomosis_action_record" ("payment_intent_id")
  WHERE "payment_intent_id" IS NOT NULL;
