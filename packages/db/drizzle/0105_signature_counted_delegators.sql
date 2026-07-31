-- WS-M.4.2c-3 — record WHICH delegators a delegated ballot's weight consumed.
--
-- The per-account cap discards delegated units beyond the ceiling, so "the
-- delegation existed when the delegate signed" and "the delegation is inside
-- that snapshot" are two different facts.  The double-count guard read the
-- first and refused the second, which disenfranchised every delegator the cap
-- dropped: their unit left the tally while their own ballot was refused.  The
-- resolver now stops folding at the cap and names the delegators it consumed;
-- this column is where that answer is frozen at signing time, so no later
-- reader has to reconstruct it from delegations that have since changed.
--
-- NULL means "not recorded" (pre-migration rows, and every non-delegated
-- model).  Readers fall back to the old existence test there, which
-- over-counts consumption but never double-counts weight.
ALTER TABLE "knomosis"."governance_signature"
  ADD COLUMN IF NOT EXISTS "counted_delegator_ids" jsonb;
