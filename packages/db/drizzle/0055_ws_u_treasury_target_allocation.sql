-- WS-U treasury auditability: persist the per-asset target allocation of an
-- investment_rebalance alongside its kernel verdict, so an ACCEPTED rebalance can
-- be audited / replayed to prove which allocation satisfied the community-voted
-- investment bands (the verdict evidence alone only records that the bands passed).
-- Null for non-rebalance categories and for pre-migration rows.
ALTER TABLE "knomosis"."agent_treasury_action" ADD COLUMN "target_allocation" jsonb;
