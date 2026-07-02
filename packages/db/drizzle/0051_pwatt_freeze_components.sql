-- WS-E.2.3e (SPEC §5.3 "freeze ranking growth") — pin the SERVED PWAtt
-- components at freeze time.  The WS-I ranking feature store reads the stored
-- `active_attention` / `participation` components (NOT the composite score), so
-- freezing only the composite let a frozen item keep growing from fresh
-- (cascade-inflated) attention.  These two nullable columns capture the
-- pre-cascade component level the scoring path pins the frozen item at (null ⇒
-- pinned to 0 — a brand-new item whose first window is a cascade has no prior
-- legitimate level).  Additive, column-only: existing rows default to NULL.
ALTER TABLE "item_safety_states" ADD COLUMN "frozen_active_attention" double precision;--> statement-breakpoint
ALTER TABLE "item_safety_states" ADD COLUMN "frozen_participation" double precision;--> statement-breakpoint
-- Backfill ALREADY-frozen items so the new NULL-means-zero rule cannot ZERO a
-- legacy frozen item's served level.  Without this, a database with pre-existing
-- `safety_state = 'frozen'` rows leaves both columns NULL; the next PWAtt
-- recompute would then pin `active_attention` / `participation` to 0 instead of
-- the level the item held when frozen.  We seed the pin from the latest SERVING
-- PWAtt output per item — `shadow_mode = false` (post-§30.5-lift) AND not
-- degraded (no TIMEOUT / COMPUTE_ERROR / INSUFFICIENT_COVERAGE reason code),
-- preferring `PWAtt_v1` over `PWAtt_v0` — i.e. the SAME serving-row gate
-- `pwattRowForRanking` applies at read time.  An item with no serving PWAtt row
-- stays NULL (⇒ pinned to 0): there is no legitimate served level to preserve,
-- so 0 is the honest floor, matching a first-window cascade.
UPDATE "item_safety_states" AS s
SET
  "frozen_active_attention" = latest.aa,
  "frozen_participation" = latest.pp
FROM (
  SELECT DISTINCT ON (io."target_id")
    io."target_id" AS target_id,
    (io."score_vector" ->> 'active_attention')::double precision AS aa,
    (io."score_vector" ->> 'participation')::double precision AS pp
  FROM "invariant_outputs" AS io
  WHERE io."invariant_type" IN ('PWAtt_v1', 'PWAtt_v0')
    AND io."shadow_mode" = false
    AND NOT (io."reason_codes" ?| array['TIMEOUT', 'COMPUTE_ERROR', 'INSUFFICIENT_COVERAGE'])
    AND io."score_vector" ? 'active_attention'
    AND io."score_vector" ? 'participation'
  ORDER BY io."target_id", (io."invariant_type" = 'PWAtt_v1') DESC, io."created_at" DESC
) AS latest
WHERE s."item_id" = latest.target_id
  AND s."safety_state" = 'frozen'
  AND s."frozen_active_attention" IS NULL;
