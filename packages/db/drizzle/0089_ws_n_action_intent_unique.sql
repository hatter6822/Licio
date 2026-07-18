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
--
-- Scoped to LIVE attempts, and both halves of that matter:
--
--   • `payment_intent_id IS NOT NULL` — a direct action settles no intent and
--     keeps only its actor-scoped key.
--   • `submission_state NOT IN ('failed','reverted')` — the invariant is ONE
--     LIVE action per intent, not one ever.  `retryIntent` re-arms a
--     failed/reverted intent (`failed|reverted -> created`, WS-M.3.1b) and the
--     next attempt mints a REPLACEMENT action under a rotated key (W14); an
--     index spanning every state would collide with the dead attempt's row and
--     replay a corpse instead, stranding the retried transfer.  A dead attempt
--     has released the intent, so it releases the index with it.
ALTER TABLE "knomosis"."knomosis_action_record"
  ADD COLUMN IF NOT EXISTS "payment_intent_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knomosis_action_intent_uq"
  ON "knomosis"."knomosis_action_record" ("payment_intent_id")
  WHERE "payment_intent_id" IS NOT NULL
    AND "submission_state" NOT IN ('failed', 'reverted');
