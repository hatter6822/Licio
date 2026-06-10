CREATE TYPE "public"."aggregation_window_size" AS ENUM('1h', '6h', '24h', '7d');--> statement-breakpoint
CREATE TYPE "public"."branch_depth_bucket" AS ENUM('none', 'shallow', 'moderate', 'deep');--> statement-breakpoint
CREATE TYPE "public"."collection_privacy_level" AS ENUM('standard', 'reduced', 'minimum');--> statement-breakpoint
CREATE TYPE "public"."dwell_bucket" AS ENUM('none', 'glance', 'short', 'medium', 'long', 'extended');--> statement-breakpoint
CREATE TYPE "public"."event_privacy_classification" AS ENUM('public', 'aggregated', 'sensitive', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."item_safety_state" AS ENUM('normal', 'frozen', 'removed');--> statement-breakpoint
CREATE TYPE "public"."retention_tier" AS ENUM('attention_raw', 'attention_aggregated', 'public_contribution', 'ranking_log', 'moderation_legal', 'account_active', 'security_log');--> statement-breakpoint
CREATE TYPE "public"."return_visit_bucket" AS ENUM('none', 'few', 'several', 'many');--> statement-breakpoint
CREATE TABLE "aggregation_windows" (
	"item_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_size" "aggregation_window_size" NOT NULL,
	"unique_active_users" integer NOT NULL,
	"source_opens" integer NOT NULL,
	"context_opens" integer NOT NULL,
	"return_visits" integer NOT NULL,
	"contribution_counts" jsonb NOT NULL,
	"anti_signal_counts" jsonb NOT NULL,
	"event_count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aggregation_windows_item_id_window_start_window_size_pk" PRIMARY KEY("item_id","window_start","window_size"),
	CONSTRAINT "aggregation_windows_nonneg" CHECK ("aggregation_windows"."unique_active_users" >= 0 and "aggregation_windows"."source_opens" >= 0 and "aggregation_windows"."context_opens" >= 0 and "aggregation_windows"."return_visits" >= 0 and "aggregation_windows"."event_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "attention_aggregates" (
	"aggregate_id" uuid PRIMARY KEY NOT NULL,
	"user_id_or_privacy_bucket" text NOT NULL,
	"story_id" uuid NOT NULL,
	"session_bucket" text NOT NULL,
	"active_dwell_bucket" "dwell_bucket" NOT NULL,
	"source_opened" boolean NOT NULL,
	"context_opened" boolean NOT NULL,
	"branch_depth_bucket" "branch_depth_bucket" NOT NULL,
	"return_visit_count_bucket" "return_visit_bucket" NOT NULL,
	"privacy_level" "collection_privacy_level" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attention_aggregates_user_len" CHECK (char_length("attention_aggregates"."user_id_or_privacy_bucket") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "consumer_checkpoints" (
	"consumer_name" text PRIMARY KEY NOT NULL,
	"last_event_timestamp" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_dead_letters" (
	"dead_letter_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consumer_name" text NOT NULL,
	"event_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"error" text NOT NULL,
	"attempts" integer NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"topic" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"privacy_classification" "event_privacy_classification" NOT NULL,
	"retention_tier" "retention_tier" NOT NULL,
	"payload" jsonb NOT NULL,
	"owner_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone,
	"review_flagged_at" timestamp with time zone,
	CONSTRAINT "events_event_id_retention_tier_pk" PRIMARY KEY("event_id","retention_tier")
) PARTITION BY LIST ("retention_tier");
--> statement-breakpoint
-- WS-E.3.1: one partition per retention tier so sweeps prune partitions
-- instead of full-scanning, and dropping a partition is provably complete
-- deletion (no orphaned rows). The DEFAULT partition catches any future tier
-- added before its partition exists (fail-safe, not fail-open: rows are still
-- classified and swept by tier).
CREATE TABLE "events_attention_raw" PARTITION OF "events" FOR VALUES IN ('attention_raw');--> statement-breakpoint
CREATE TABLE "events_attention_aggregated" PARTITION OF "events" FOR VALUES IN ('attention_aggregated');--> statement-breakpoint
CREATE TABLE "events_public_contribution" PARTITION OF "events" FOR VALUES IN ('public_contribution');--> statement-breakpoint
CREATE TABLE "events_ranking_log" PARTITION OF "events" FOR VALUES IN ('ranking_log');--> statement-breakpoint
CREATE TABLE "events_moderation_legal" PARTITION OF "events" FOR VALUES IN ('moderation_legal');--> statement-breakpoint
CREATE TABLE "events_account_active" PARTITION OF "events" FOR VALUES IN ('account_active');--> statement-breakpoint
CREATE TABLE "events_security_log" PARTITION OF "events" FOR VALUES IN ('security_log');--> statement-breakpoint
CREATE TABLE "events_default" PARTITION OF "events" DEFAULT;--> statement-breakpoint
CREATE TABLE "invariant_outputs" (
	"invariant_output_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invariant_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"time_window" text NOT NULL,
	"version" text NOT NULL,
	"score_vector" jsonb NOT NULL,
	"explanation_summary" text,
	"confidence" double precision NOT NULL,
	"shadow_mode" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invariant_outputs_confidence" CHECK ("invariant_outputs"."confidence" >= 0 and "invariant_outputs"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "item_safety_states" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"safety_state" "item_safety_state" DEFAULT 'normal' NOT NULL,
	"frozen_score" double precision,
	"case_id" uuid,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pwatt_config" (
	"config_key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_ledger_entries" (
	"entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"story_title" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_size" "aggregation_window_size" NOT NULL,
	"signals" jsonb NOT NULL,
	"anti_signals" jsonb NOT NULL,
	"pwatt_score" double precision NOT NULL,
	"summary" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	CONSTRAINT "signal_ledger_score_range" CHECK ("signal_ledger_entries"."pwatt_score" >= 0 and "signal_ledger_entries"."pwatt_score" <= 1)
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_user_id_users_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_ledger_entries" ADD CONSTRAINT "signal_ledger_entries_owner_user_id_users_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aggregation_windows_start_idx" ON "aggregation_windows" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "attention_aggregates_user_idx" ON "attention_aggregates" USING btree ("user_id_or_privacy_bucket");--> statement-breakpoint
CREATE INDEX "attention_aggregates_story_created_idx" ON "attention_aggregates" USING btree ("story_id","created_at");--> statement-breakpoint
CREATE INDEX "attention_aggregates_created_idx" ON "attention_aggregates" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "event_dead_letters_consumer_idx" ON "event_dead_letters" USING btree ("consumer_name","failed_at");--> statement-breakpoint
CREATE INDEX "events_topic_timestamp_idx" ON "events" USING btree ("topic","timestamp");--> statement-breakpoint
CREATE INDEX "events_owner_idx" ON "events" USING btree ("owner_user_id") WHERE "events"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "events_purge_after_idx" ON "events" USING btree ("purge_after") WHERE "events"."purge_after" is not null;--> statement-breakpoint
CREATE INDEX "events_tier_timestamp_idx" ON "events" USING btree ("retention_tier","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "invariant_outputs_run_idx" ON "invariant_outputs" USING btree ("invariant_type","target_type","target_id","time_window","version");--> statement-breakpoint
CREATE INDEX "invariant_outputs_target_idx" ON "invariant_outputs" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE INDEX "invariant_outputs_created_idx" ON "invariant_outputs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_ledger_window_idx" ON "signal_ledger_entries" USING btree ("owner_user_id","item_id","window_start","window_size");--> statement-breakpoint
CREATE INDEX "signal_ledger_owner_recorded_idx" ON "signal_ledger_entries" USING btree ("owner_user_id","recorded_at");--> statement-breakpoint
CREATE INDEX "signal_ledger_purge_idx" ON "signal_ledger_entries" USING btree ("purge_after");