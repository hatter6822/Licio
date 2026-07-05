-- WS-G/WS-T — remove the §24.3 layered thread-summary feature (the conversation
-- "Overview").  The `summaries` table (the automated_draft / community_synthesis
-- / steward_summary layers), the `threads.current_summary_id` pointer, and the
-- `summary_layer` enum are dropped end to end.  IF EXISTS keeps it re-runnable.
ALTER TABLE "threads" DROP CONSTRAINT IF EXISTS "threads_current_summary_id_summaries_summary_id_fk";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN IF EXISTS "current_summary_id";--> statement-breakpoint
DROP TABLE IF EXISTS "summaries" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."summary_layer";
