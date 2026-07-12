-- STEWARD_ROLES.md ROLE_EVIDENCE (SPEC §16.3): the evidence-decision store —
-- audited evidence METADATA on citation-bearing contributions (sourced
-- comments + corrections).  `mark-primary-source` / `flag-citation` annotate
-- ONE citation; `clear` marks the contribution reviewed with no annotation.
-- The evidence queue itself is DERIVED (citation-bearing published
-- contributions with no decision row), so decisions are the only durable
-- state.  Plain uuids, no FK edges to the content plane (a decision on
-- since-removed content stays a valid accountability record); `decided_by`
-- keeps the audit-actor posture on erasure.

CREATE TYPE "evidence_decision_action" AS ENUM('mark-primary-source', 'flag-citation', 'clear');--> statement-breakpoint
CREATE TABLE "evidence_decisions" (
  "decision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contribution_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  "story_id" uuid,
  "action" "evidence_decision_action" NOT NULL,
  "citation_url" text,
  "citation_title" text,
  "reason_code" text,
  "note" text,
  "decided_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "evidence_decisions_citation_shape" CHECK (("action" = 'clear' and "citation_url" is null) or ("action" <> 'clear' and "citation_url" is not null)),
  CONSTRAINT "evidence_decisions_url_len" CHECK (char_length("citation_url") <= 2048)
);--> statement-breakpoint
CREATE INDEX "evidence_decisions_contribution_idx" ON "evidence_decisions" ("contribution_id");--> statement-breakpoint
CREATE INDEX "evidence_decisions_story_action_idx" ON "evidence_decisions" ("story_id", "action", "created_at");--> statement-breakpoint
CREATE INDEX "evidence_decisions_created_idx" ON "evidence_decisions" ("created_at", "decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_decisions_citation_uq" ON "evidence_decisions" ("contribution_id", "citation_url", "action") WHERE "citation_url" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_decisions_clear_uq" ON "evidence_decisions" ("contribution_id") WHERE "action" = 'clear';
