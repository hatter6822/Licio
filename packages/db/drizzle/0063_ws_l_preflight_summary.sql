-- WS-L.3.4c / O2 — persist the deterministic human summary the user saw and
-- signed at preflight (the `buildHumanSummary` output paired with
-- `summary_payload_hash`).  Receipts are written LATER, at a stable state during
-- ingest; without the persisted preflight summary the receipt paired a new
-- state-derived string whose `summary_payload_hash` could never match the
-- preflight hash, so receipts no longer audited what the user actually approved.
-- The receipt writer now pairs against this column (nullable for pre-O2 rows).
ALTER TABLE "knomosis"."knomosis_action_record" ADD COLUMN "preflight_summary" text;
