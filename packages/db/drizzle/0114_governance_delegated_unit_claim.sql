-- WS-M.4.2c — make "one delegated unit, one ballot" a DATABASE guarantee.
--
-- `counted_delegator_ids` on `governance_signature` records which delegated units a
-- ballot consumed, and a pre-insert read (`delegatorsAlreadyConsumed`) was what kept
-- two ballots from consuming the same one.  A read cannot do that job.  A member who
-- splits an `all` delegation to one delegate and a `type:<proposal>` delegation to
-- another lets both delegates resolve weight from the same uncommitted view: each
-- `consumedElsewhere` check comes back empty, both signatures insert, and the unit is
-- counted twice in the tally.  Nothing existing rejects it —
-- `governance_signature_unique_idx` is keyed on the WALLET, and no unique index can
-- constrain elements of a JSONB array across rows.
--
-- So each consumed unit becomes a ROW claimed in the same transaction as the
-- signature.  The primary key decides the race; the loser rolls back whole rather
-- than recording weight it did not win, and re-submits against a view that now
-- contains the winner.
--
-- ON DELETE CASCADE is load-bearing on both parents.  A ballot reverted by
-- `removeByAction`, or erased by `purgeByUser`, MUST release its claims — otherwise
-- the delegator's unit is disenfranchised for that proposal for ever, which is a
-- worse failure than the double-count this table exists to prevent.
CREATE TABLE IF NOT EXISTS "knomosis"."governance_delegated_unit_claim" (
  "proposal_id" uuid NOT NULL
    REFERENCES "knomosis"."governance_proposal" ("proposal_id") ON DELETE CASCADE,
  -- NO foreign key to `users`, deliberately.  `counted_delegator_ids` on the
  -- signature is the same reference and carries none either, and making one of two
  -- spellings of one fact referentially strict is how they come to disagree: an
  -- account deleted between weight resolution and this insert would turn a valid
  -- ballot into a 500, and a cascade here would release a claim while the
  -- signature's frozen JSONB still records it.  Release is already covered by the
  -- signature cascade below, which is the only event that should free a unit.
  "delegator_user_id" uuid NOT NULL,
  "signature_id" uuid NOT NULL
    REFERENCES "knomosis"."governance_signature" ("signature_id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "governance_delegated_unit_claim_pk"
    PRIMARY KEY ("proposal_id", "delegator_user_id")
);
--> statement-breakpoint
-- The release path deletes by signature, and so does the cascade.
CREATE INDEX IF NOT EXISTS "governance_delegated_unit_claim_signature_idx"
  ON "knomosis"."governance_delegated_unit_claim" ("signature_id");
--> statement-breakpoint
-- BACKFILL the units already frozen on existing ballots, so the constraint describes
-- the CURRENT tally rather than only future ones.  A duplicate already recorded by
-- the race this closes cannot be resolved by a migration — which ballot legitimately
-- won is a governance question, not a data question — so the insert keeps the first
-- claim per (proposal, delegator) deterministically by signature creation order and
-- leaves the second ballot's row untouched.  `check:sql-identifiers` covers the
-- names above; the ordering here is what makes the backfill reproducible.
INSERT INTO "knomosis"."governance_delegated_unit_claim"
  ("proposal_id", "delegator_user_id", "signature_id", "created_at")
SELECT DISTINCT ON (s."proposal_id", d."delegator")
  s."proposal_id",
  d."delegator"::uuid,
  s."signature_id",
  s."created_at"
FROM "knomosis"."governance_signature" s
CROSS JOIN LATERAL jsonb_array_elements_text(s."counted_delegator_ids") AS d("delegator")
WHERE s."counted_delegator_ids" IS NOT NULL
  AND jsonb_typeof(s."counted_delegator_ids") = 'array'
ORDER BY s."proposal_id", d."delegator", s."created_at", s."signature_id"
ON CONFLICT DO NOTHING;
