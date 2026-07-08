-- WS-L.4.1c / P2 — make the `execution_simulated` governance audit durable across a
-- crash between `finalizeExecution` and the audit append.  The row is now written
-- BEFORE the finalize CAS (while the proposal is still the recoverable `executing`
-- state) and is idempotent by proposal via this key: Postgres treats NULLs as
-- DISTINCT, so the unique index leaves ordinary (NULL-key) audits unconstrained while
-- a non-null key is written at most once — a re-drive by the recovery sweep repairs a
-- dropped audit without ever duplicating it.
ALTER TABLE "knomosis"."governance_audit_log" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_audit_log_dedupe_idx" ON "knomosis"."governance_audit_log" USING btree ("dedupe_key");
