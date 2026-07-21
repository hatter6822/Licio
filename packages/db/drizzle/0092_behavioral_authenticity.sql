-- Bot-prevention layer 2 (WS-E/WS-H BAI): per-actor behavior snapshots + the
-- current authenticity assessment, and the invariant-type vocabulary gains
-- 'behavioral_authenticity' (the 12th platform invariant family).
--
-- Privacy posture: rows exist ONLY for identifiable actors (the coarse
-- privacy-bucket actor is never profiled), carry nothing beyond the coarse
-- §22.1 buckets the aggregates already disclose, cascade with the users row,
-- and are pruned past the retention horizon by the hourly behavior job.
CREATE TABLE "actor_behavior_windows" (
	"actor_ref" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"event_count" integer NOT NULL,
	"items_touched" integer NOT NULL,
	"dwell_histogram" jsonb NOT NULL,
	"reply_depth_histogram" jsonb NOT NULL,
	"return_histogram" jsonb NOT NULL,
	"source_opens" integer NOT NULL,
	"context_opens" integer NOT NULL,
	"saves" integer NOT NULL,
	"contributions" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_behavior_windows_actor_ref_window_start_pk" PRIMARY KEY("actor_ref","window_start"),
	CONSTRAINT "actor_behavior_windows_nonneg" CHECK ("actor_behavior_windows"."event_count" >= 0 and "actor_behavior_windows"."items_touched" >= 0 and "actor_behavior_windows"."source_opens" >= 0 and "actor_behavior_windows"."context_opens" >= 0 and "actor_behavior_windows"."saves" >= 0 and "actor_behavior_windows"."contributions" >= 0)
);--> statement-breakpoint
CREATE TABLE "actor_authenticity_scores" (
	"actor_ref" uuid PRIMARY KEY NOT NULL,
	"score" double precision NOT NULL,
	"coherence" double precision NOT NULL,
	"components" jsonb NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" integer NOT NULL,
	"cluster_id" text,
	"cluster_size" integer DEFAULT 1 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_authenticity_score_range" CHECK ("actor_authenticity_scores"."score" > 0 and "actor_authenticity_scores"."score" <= 1),
	CONSTRAINT "actor_authenticity_coherence_range" CHECK ("actor_authenticity_scores"."coherence" > 0 and "actor_authenticity_scores"."coherence" <= 1),
	CONSTRAINT "actor_authenticity_cluster_size" CHECK ("actor_authenticity_scores"."cluster_size" >= 1 and ("actor_authenticity_scores"."cluster_id" is not null or "actor_authenticity_scores"."cluster_size" = 1))
);--> statement-breakpoint
ALTER TABLE "actor_behavior_windows" ADD CONSTRAINT "actor_behavior_windows_actor_ref_users_user_id_fk" FOREIGN KEY ("actor_ref") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_authenticity_scores" ADD CONSTRAINT "actor_authenticity_scores_actor_ref_users_user_id_fk" FOREIGN KEY ("actor_ref") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actor_behavior_windows_start_idx" ON "actor_behavior_windows" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "actor_authenticity_cluster_idx" ON "actor_authenticity_scores" USING btree ("cluster_id");--> statement-breakpoint
ALTER TABLE "invariant_outputs" DROP CONSTRAINT "invariant_outputs_type";--> statement-breakpoint
ALTER TABLE "invariant_outputs" ADD CONSTRAINT "invariant_outputs_type" CHECK ("invariant_outputs"."invariant_type" in ('MERI', 'MFCI', 'GWEI', 'SCOI', 'PHI', 'hodge_tension', 'tropical_cascade', 'braid_dynamics', 'reeb_landscape', 'counterfactual_defect', 'path_signature_wellbeing', 'behavioral_authenticity', 'PWAtt_v0', 'PWAtt_v1'));
