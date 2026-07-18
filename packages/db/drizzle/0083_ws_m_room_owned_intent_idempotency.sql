-- WS-M.3.1c (PR #144 review): ROOM-owned payment intents.
--
-- Grant/compensation payout intents carry user_id NULL (the payout belongs to
-- the treasury, not to whichever steward accepted the milestone).  The
-- existing (user_id, room_id, idempotency_key) unique index treats NULLs as
-- distinct, so a NULL-owner scope needs its own partial unique index for the
-- milestone-keyed idempotency to hold across stewards: two stewards accepting
-- the same milestone converge on ONE intent.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_intent_room_idem_uq"
  ON "knomosis"."payment_intent" ("room_id", "idempotency_key")
  WHERE "user_id" IS NULL;
