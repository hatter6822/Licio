ALTER TYPE "public"."audit_event_type" ADD VALUE 'scoi_context_action';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'bridge_request';--> statement-breakpoint
CREATE TABLE "bridge_attempts" (
	"attempt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" text NOT NULL,
	"candidate_user_ids" jsonb NOT NULL,
	"contribution_id" uuid,
	"bridge_user_id" uuid,
	"scoi_baseline" double precision NOT NULL,
	"scoi_after" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "bridge_attempts_status" CHECK ("bridge_attempts"."status" in ('requested', 'credited')),
	CONSTRAINT "bridge_attempts_baseline" CHECK ("bridge_attempts"."scoi_baseline" >= 0 and "bridge_attempts"."scoi_baseline" <= 1)
);
--> statement-breakpoint
CREATE TABLE "scoi_context_actions" (
	"action_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"related_thread_id" uuid,
	"story_id" uuid NOT NULL,
	"room_id" uuid,
	"reason_code" text NOT NULL,
	"annotation" text,
	"actor_ref" text NOT NULL,
	"scoi_before" double precision,
	"scoi_after" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoi_context_actions_action" CHECK ("scoi_context_actions"."action" in ('merge', 'annotate', 'separate')),
	CONSTRAINT "scoi_context_actions_reason_len" CHECK (char_length("scoi_context_actions"."reason_code") between 1 and 64)
);
--> statement-breakpoint
CREATE INDEX "bridge_attempts_thread_idx" ON "bridge_attempts" USING btree ("thread_id","status");--> statement-breakpoint
CREATE INDEX "scoi_context_actions_thread_idx" ON "scoi_context_actions" USING btree ("thread_id","created_at");