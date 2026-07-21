-- WS-U role split + model candidacy (SPEC §24.6; docs/governance/README.md).
-- 1. `admitted_adjudication_backend_id` — the ADJUDICATION lane's admission pin
--    (the moderation/adjudication model split): the backend the adjudication
--    validity probe passed under at admission. The room's LLM debate leg fails
--    closed to the platform adjudicator under any other backend. Null on
--    pre-split rows; the governance scheduler's repin sweep re-probes and
--    heals them.
-- 2. `hub_verification` — the propose-time huggingface.co verification
--    snapshots for a bundle's member-selected model references (per-role
--    metadata: pipeline, license, parameter count, pinned revision), kept for
--    transparency and audit. Null when the bundle selects no hub model.
ALTER TABLE "knomosis"."room_governance_model"
  ADD COLUMN "admitted_adjudication_backend_id" text;
--> statement-breakpoint
ALTER TABLE "knomosis"."room_governance_model"
  ADD COLUMN "hub_verification" jsonb;
