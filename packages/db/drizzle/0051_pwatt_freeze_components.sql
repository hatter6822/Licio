-- WS-E.2.3e (SPEC §5.3 "freeze ranking growth") — pin the SERVED PWAtt
-- components at freeze time.  The WS-I ranking feature store reads the stored
-- `active_attention` / `participation` components (NOT the composite score), so
-- freezing only the composite let a frozen item keep growing from fresh
-- (cascade-inflated) attention.  These two nullable columns capture the
-- pre-cascade component level the scoring path pins the frozen item at (null ⇒
-- pinned to 0 — a brand-new item whose first window is a cascade has no prior
-- legitimate level).  Additive, column-only: existing rows default to NULL.
ALTER TABLE "item_safety_states" ADD COLUMN "frozen_active_attention" double precision;--> statement-breakpoint
ALTER TABLE "item_safety_states" ADD COLUMN "frozen_participation" double precision;
