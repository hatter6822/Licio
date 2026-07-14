-- WS-M.3.1b (PR #144 review, wave 12): ONE intent per WS-L action record,
-- enforced at the DATABASE.
--
-- The attach path pre-checks findByActionRecordId, but two same-shape signed
-- intents racing the same valid action could both pass the read before either
-- transition stored action_record_id; reconciliation would then finalize both
-- from one transfer/receipt.  The partial unique closes the race: the losing
-- attach's UPDATE violates it and surfaces as a clean CAS loss.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_intent_action_uq"
  ON "knomosis"."payment_intent" ("action_record_id")
  WHERE "action_record_id" IS NOT NULL;
