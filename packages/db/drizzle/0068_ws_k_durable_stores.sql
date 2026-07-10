-- WS-K durable-store completion — the two tables the in-memory-only stores
-- lacked, landing alongside the Drizzle adapters that make the WS-K governance
-- state (registry/deploy gate, AIOutputRecords, lineage, evaluations, review
-- queue, …) survive a restart and be shared across instances in production.
--
-- 1. `ai_review_queue` — the WS-K human-review queue: low-confidence
--    classifications, reported summaries/translations, and flagged
--    hallucinations awaiting a steward.  Metadata + soft refs only.
--
-- 2. `ai_moderation_decisions` — the WS-U ADR-9 in-room moderation decision
--    log: what the model PROPOSED vs what the deterministic wrapper PERMITTED
--    (the transparency of bounded autonomy).  Append-only; metadata only — NO
--    content text, NO attention values, NO user identity beyond the
--    contribution ref the agent-action audit log already carries.
CREATE TABLE "ai_review_queue" (
	"review_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_ref" text NOT NULL,
	"context" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "ai_review_queue_status" CHECK ("ai_review_queue"."status" in ('pending', 'resolved')),
	CONSTRAINT "ai_review_queue_kind" CHECK ("ai_review_queue"."kind" in ('low_confidence_classification', 'reported_summary', 'reported_translation', 'flagged_hallucination')),
	CONSTRAINT "ai_review_queue_resolved" CHECK (("ai_review_queue"."status" = 'resolved') = ("ai_review_queue"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE INDEX "ai_review_queue_status_idx" ON "ai_review_queue" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "ai_review_queue_kind_idx" ON "ai_review_queue" USING btree ("kind","created_at");
--> statement-breakpoint
CREATE TABLE "ai_moderation_decisions" (
	"record_id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"subject_ref" text NOT NULL,
	"proposed_action" text NOT NULL,
	"bounded_action" text NOT NULL,
	"clamped" boolean NOT NULL,
	"output_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ai_moderation_decisions_room_idx" ON "ai_moderation_decisions" USING btree ("room_id","created_at");
