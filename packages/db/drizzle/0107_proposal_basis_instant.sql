-- WS-M.4.2c — record WHEN the proposal electorate was frozen, not just its size.
--
-- `eligible_basis_count` is stamped by the scheduler at the deliberation → open
-- transition, and the ballot cutoff read `deliberation_ends_at` — the SCHEDULED
-- deadline.  Ordinary tick lag (or a prolonged room freeze) puts the two apart:
-- the count is the membership at the later transition, while the cutoff rejects
-- everyone who joined after the earlier deadline.  Those members inflate the
-- quorum denominator while being unable to cast a ballot, so enough joins during
-- the delay make quorum unreachable no matter how many eligible members vote.
--
-- One instant answers both questions.  NULL on pre-migration rows, where the
-- cutoff falls back to `deliberation_ends_at` — the behaviour those rows were
-- opened under.
ALTER TABLE "knomosis"."governance_proposal"
  ADD COLUMN IF NOT EXISTS "eligible_basis_at" timestamp with time zone;
