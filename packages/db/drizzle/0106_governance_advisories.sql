-- WS-K §24.5 — persist the governance ADVISORIES a steward is meant to read.
--
-- `highlightConflictOfInterest` and `detectScamPatterns` returned a concrete
-- advisory (proposer-is-recipient, scam-associated language) and the production
-- caller discarded the value: no store, no route, no reader.  The advice the
-- wiring claimed to provide reached nobody, so a steward could not see it, act
-- on it, or knowingly ignore it — and "advisory" only means anything when
-- someone can read the advice.  Mirrors `ai_governance_summaries`.
CREATE TABLE IF NOT EXISTS "ai_governance_advisories" (
  "advisory_id" text PRIMARY KEY NOT NULL,
  "proposal_ref" text NOT NULL,
  "kind" text NOT NULL,
  "advisory" jsonb NOT NULL,
  "output_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_governance_advisories_proposal_idx"
  ON "ai_governance_advisories" ("proposal_ref");
