-- WS-K AI & Model Governance (SPEC §24): model registry/cards, risk
-- assessments, AI inventory, immutable data lineage + audit-sensitive output
-- records, evaluation harness decisions, human-in-the-loop corrections, the
-- pre-execution prohibited-use block audit, AI summaries/translations + their
-- reports, governance proposal summaries, and runtime monitoring.
CREATE TABLE "ai_blocked_invocations" (
	"block_id" text PRIMARY KEY NOT NULL,
	"prohibition" text NOT NULL,
	"use_case_id" text NOT NULL,
	"capability" text NOT NULL,
	"caller" text NOT NULL,
	"context_ref" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_corrections" (
	"correction_id" text PRIMARY KEY NOT NULL,
	"output_id" text NOT NULL,
	"use_case_id" text NOT NULL,
	"action" text NOT NULL,
	"original_value" text NOT NULL,
	"corrected_value" text,
	"steward_ref" text NOT NULL,
	"category" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_corrections_action" CHECK ("ai_corrections"."action" in ('confirm', 'reject', 'modify')),
	CONSTRAINT "ai_corrections_modify_value" CHECK (("ai_corrections"."action" = 'modify') = ("ai_corrections"."corrected_value" is not null))
);
--> statement-breakpoint
CREATE TABLE "ai_data_lineage" (
	"dataset_id" text NOT NULL,
	"version" text NOT NULL,
	"record" jsonb NOT NULL,
	"contains_user_derived" boolean NOT NULL,
	"usable" boolean NOT NULL,
	"privacy_review_ref" text,
	"predecessor_dataset_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_data_lineage_dataset_id_version_pk" PRIMARY KEY("dataset_id","version"),
	CONSTRAINT "ai_data_lineage_privacy_review" CHECK ((not "ai_data_lineage"."usable") or (not "ai_data_lineage"."contains_user_derived") or ("ai_data_lineage"."privacy_review_ref" is not null))
);
--> statement-breakpoint
CREATE TABLE "ai_evaluations" (
	"evaluation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"decision" text NOT NULL,
	"decision_data" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_evaluations_decision" CHECK ("ai_evaluations"."decision" in ('deploy', 'block'))
);
--> statement-breakpoint
CREATE TABLE "ai_governance_summaries" (
	"summary_id" text PRIMARY KEY NOT NULL,
	"proposal_ref" text NOT NULL,
	"summary" jsonb NOT NULL,
	"output_id" text NOT NULL,
	"steward_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_inventory_versions" (
	"version" integer PRIMARY KEY NOT NULL,
	"inventory" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_model_cards" (
	"name" text NOT NULL,
	"version" text NOT NULL,
	"card" jsonb NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"deprecation" jsonb,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deployed_at" timestamp with time zone,
	CONSTRAINT "ai_model_cards_name_version_pk" PRIMARY KEY("name","version"),
	CONSTRAINT "ai_model_cards_status" CHECK ("ai_model_cards"."status" in ('registered', 'deployed', 'deprecated'))
);
--> statement-breakpoint
CREATE TABLE "ai_output_records" (
	"output_id" text PRIMARY KEY NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"prompt_template_id" text NOT NULL,
	"config_hash" text NOT NULL,
	"input_refs" jsonb NOT NULL,
	"output_ref" text NOT NULL,
	"use_case_id" text NOT NULL,
	"correction_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_output_records_config_hash" CHECK ("ai_output_records"."config_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "ai_risk_assessments" (
	"assessment_id" text PRIMARY KEY NOT NULL,
	"use_case_id" text NOT NULL,
	"assessment" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runtime_alerts" (
	"alert_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"threshold" double precision NOT NULL,
	"rollback_recommendation" text,
	"raised_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runtime_metrics" (
	"metric_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_summary_drafts" (
	"summary_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"draft" jsonb NOT NULL,
	"output_id" text NOT NULL,
	"quality_passed" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_summary_reports" (
	"report_id" text PRIMARY KEY NOT NULL,
	"summary_id" text NOT NULL,
	"reason" text NOT NULL,
	"correction_text" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_translation_reports" (
	"report_id" text PRIMARY KEY NOT NULL,
	"translation_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_translations" (
	"translation_id" text PRIMARY KEY NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_lang" text NOT NULL,
	"target_lang" text NOT NULL,
	"translated_text" text NOT NULL,
	"consistency_passed" boolean NOT NULL,
	"output_id" text NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_translations_langs" CHECK ("ai_translations"."source_lang" <> "ai_translations"."target_lang")
);
--> statement-breakpoint
CREATE INDEX "ai_blocked_invocations_prohibition_idx" ON "ai_blocked_invocations" USING btree ("prohibition","created_at");
--> statement-breakpoint
CREATE INDEX "ai_blocked_invocations_created_idx" ON "ai_blocked_invocations" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "ai_corrections_use_case_idx" ON "ai_corrections" USING btree ("use_case_id","created_at");
--> statement-breakpoint
CREATE INDEX "ai_corrections_output_idx" ON "ai_corrections" USING btree ("output_id");
--> statement-breakpoint
CREATE INDEX "ai_data_lineage_usable_idx" ON "ai_data_lineage" USING btree ("usable");
--> statement-breakpoint
CREATE INDEX "ai_evaluations_model_idx" ON "ai_evaluations" USING btree ("model_name","model_version","evaluated_at");
--> statement-breakpoint
CREATE INDEX "ai_governance_summaries_proposal_idx" ON "ai_governance_summaries" USING btree ("proposal_ref");
--> statement-breakpoint
CREATE INDEX "ai_model_cards_name_idx" ON "ai_model_cards" USING btree ("name");
--> statement-breakpoint
CREATE INDEX "ai_model_cards_status_idx" ON "ai_model_cards" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "ai_output_records_model_idx" ON "ai_output_records" USING btree ("model_name","model_version");
--> statement-breakpoint
CREATE INDEX "ai_output_records_use_case_idx" ON "ai_output_records" USING btree ("use_case_id","created_at");
--> statement-breakpoint
CREATE INDEX "ai_output_records_created_idx" ON "ai_output_records" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "ai_runtime_alerts_model_idx" ON "ai_runtime_alerts" USING btree ("model_name","model_version","raised_at");
--> statement-breakpoint
CREATE INDEX "ai_runtime_metrics_model_idx" ON "ai_runtime_metrics" USING btree ("model_name","model_version","metric","recorded_at");
--> statement-breakpoint
CREATE INDEX "ai_summary_drafts_thread_idx" ON "ai_summary_drafts" USING btree ("thread_id");
--> statement-breakpoint
CREATE INDEX "ai_summary_reports_summary_idx" ON "ai_summary_reports" USING btree ("summary_id","created_at");
--> statement-breakpoint
CREATE INDEX "ai_translation_reports_translation_idx" ON "ai_translation_reports" USING btree ("translation_id");
--> statement-breakpoint
CREATE INDEX "ai_translations_source_idx" ON "ai_translations" USING btree ("source_ref","target_lang");
