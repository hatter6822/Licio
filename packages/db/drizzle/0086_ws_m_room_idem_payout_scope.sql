-- WS-M.3.1c (PR #144 review, wave 10): scope the NULL-owner idempotency
-- unique to PAYOUT targets.
--
-- The 0083 partial index covered every row whose user_id is NULL — but
-- account ERASURE also nulls user_id on member deposit intents, so two
-- erased members who happened to use the same client-minted key in one room
-- would collide at erasure time.  Room-owned idempotency only ever applies
-- to the payout classes (grant_payout / steward_compensation, minted with a
-- NULL owner by design); scoping the index there keeps the milestone-keyed
-- convergence and frees erased deposits from the uniqueness.
DROP INDEX IF EXISTS "knomosis"."payment_intent_room_idem_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_intent_room_idem_uq"
  ON "knomosis"."payment_intent" ("room_id", "idempotency_key")
  WHERE "user_id" IS NULL
    AND "target_type" IN ('grant_payout', 'steward_compensation');
