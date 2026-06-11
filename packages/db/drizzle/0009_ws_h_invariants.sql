-- WS-H invariant computation platform (hand-tuned; SPEC §21.4/§22.1/§30.4).
-- Drizzle-kit diffed against the pre-WS-G snapshot, so the generated file was
-- replaced with exactly the WS-H delta (the 0009 snapshot now reflects the
-- full current schema, so future diffs are clean again). Two changes need
-- custom SQL:
--   1. invariant_outputs.time_window converts text → jsonb {start, end} with
--      a USING expression that parses the legacy "<start ISO>/<size>" label
--      (the only writer was windowLabel(); sizes are 1h/6h/24h/7d).
--   2. The new coverage column backfills existing PWAtt rows at 1.0 (window
--      folds always had complete inputs), then drops the default so every
--      future insert must state its coverage explicitly (WS-H.1.1c).
ALTER TABLE "invariant_outputs" ALTER COLUMN "time_window" SET DATA TYPE jsonb
  USING jsonb_build_object(
    'start', split_part("time_window", '/', 1),
    'end', to_char(
      ((split_part("time_window", '/', 1))::timestamptz + CASE split_part("time_window", '/', 2)
        WHEN '1h' THEN interval '1 hour'
        WHEN '6h' THEN interval '6 hours'
        WHEN '24h' THEN interval '24 hours'
        WHEN '7d' THEN interval '7 days'
        ELSE interval '0' END) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );--> statement-breakpoint
ALTER TABLE "invariant_outputs" ADD COLUMN "coverage" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "invariant_outputs" ALTER COLUMN "coverage" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invariant_outputs" ADD COLUMN "reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invariant_outputs" ADD COLUMN "fallback_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invariant_outputs" ADD COLUMN "version_metadata" jsonb;--> statement-breakpoint
-- Standardize the stored PWAtt v1 family name before the closed-vocabulary
-- CHECK lands (the wire event keeps the family-level 'PWAtt').
UPDATE "invariant_outputs" SET "invariant_type" = 'PWAtt_v1' WHERE "invariant_type" = 'PWAtt';--> statement-breakpoint
DROP INDEX "invariant_outputs_target_idx";--> statement-breakpoint
CREATE INDEX "invariant_outputs_target_idx" ON "invariant_outputs" USING btree ("target_id","invariant_type");--> statement-breakpoint
CREATE INDEX "invariant_outputs_type_target_idx" ON "invariant_outputs" USING btree ("invariant_type","target_type","target_id");--> statement-breakpoint
CREATE INDEX "invariant_outputs_type_version_idx" ON "invariant_outputs" USING btree ("invariant_type","version");--> statement-breakpoint
CREATE INDEX "invariant_outputs_type_target_created_idx" ON "invariant_outputs" USING btree ("invariant_type","target_type","created_at" DESC);--> statement-breakpoint
ALTER TABLE "invariant_outputs" ADD CONSTRAINT "invariant_outputs_coverage" CHECK ("invariant_outputs"."coverage" >= 0 and "invariant_outputs"."coverage" <= 1);--> statement-breakpoint
ALTER TABLE "invariant_outputs" ADD CONSTRAINT "invariant_outputs_type" CHECK ("invariant_outputs"."invariant_type" in ('MERI', 'MFCI', 'GWEI', 'SCOI', 'PHI', 'hodge_tension', 'tropical_cascade', 'braid_dynamics', 'reeb_landscape', 'counterfactual_defect', 'path_signature_wellbeing', 'PWAtt_v0', 'PWAtt_v1'));--> statement-breakpoint
ALTER TABLE "invariant_outputs" ADD CONSTRAINT "invariant_outputs_target_type" CHECK ("invariant_outputs"."target_type" in ('story', 'thread', 'feed', 'room', 'cohort', 'session'));--> statement-breakpoint
CREATE TABLE "invariant_promotions" (
	"promotion_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invariant_type" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"owner" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invariant_promotions_from_status" CHECK ("invariant_promotions"."from_status" in ('shadow', 'soft_constraint', 'hard_constraint')),
	CONSTRAINT "invariant_promotions_to_status" CHECK ("invariant_promotions"."to_status" in ('shadow', 'soft_constraint', 'hard_constraint')),
	CONSTRAINT "invariant_promotions_owner_len" CHECK (char_length("invariant_promotions"."owner") between 1 and 256)
);
--> statement-breakpoint
CREATE INDEX "invariant_promotions_type_idx" ON "invariant_promotions" USING btree ("invariant_type","created_at");--> statement-breakpoint
CREATE TABLE "invariant_calibrations" (
	"calibration_key" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"data" jsonb NOT NULL,
	"sample_count" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "invariant_calibrations_samples" CHECK ("invariant_calibrations"."sample_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invariant_run_metadata" (
	"run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invariant_type" text NOT NULL,
	"tier" text NOT NULL,
	"target_count" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"success" boolean NOT NULL,
	"failure_reason" text,
	"started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "invariant_run_metadata_tier" CHECK ("invariant_run_metadata"."tier" in ('realtime', 'near_realtime', 'batch')),
	CONSTRAINT "invariant_run_metadata_nonneg" CHECK ("invariant_run_metadata"."target_count" >= 0 and "invariant_run_metadata"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX "invariant_run_metadata_type_idx" ON "invariant_run_metadata" USING btree ("invariant_type","started_at");--> statement-breakpoint
CREATE TABLE "mfci_cases" (
	"case_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"risk_state" text NOT NULL,
	"statistic" text NOT NULL,
	"mfci_score" double precision NOT NULL,
	"p_hat" double precision NOT NULL,
	"sample_count" integer NOT NULL,
	"fixed_margins_ref" text NOT NULL,
	"summary" text NOT NULL,
	"appeal_summary" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "mfci_cases_risk_state" CHECK ("mfci_cases"."risk_state" in ('normal', 'elevated', 'high', 'severe')),
	CONSTRAINT "mfci_cases_status" CHECK ("mfci_cases"."status" in ('open', 'confirmed', 'cleared', 'escalated')),
	CONSTRAINT "mfci_cases_p_hat" CHECK ("mfci_cases"."p_hat" > 0 and "mfci_cases"."p_hat" <= 1),
	CONSTRAINT "mfci_cases_nonneg" CHECK ("mfci_cases"."mfci_score" >= 0 and "mfci_cases"."sample_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "mfci_cases_status_idx" ON "mfci_cases" USING btree ("status","opened_at");--> statement-breakpoint
CREATE INDEX "mfci_cases_target_idx" ON "mfci_cases" USING btree ("target_id");
