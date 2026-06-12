CREATE TABLE "ranking_decision_logs" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"surface" text NOT NULL,
	"user_privacy_bucket" text NOT NULL,
	"fallback" boolean NOT NULL,
	"profile_id" text NOT NULL,
	"profile_version" text NOT NULL,
	"feature_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "ranking_decision_logs_surface" CHECK ("ranking_decision_logs"."surface" in ('front_page', 'room', 'topic')),
	CONSTRAINT "ranking_decision_logs_bucket_shape" CHECK ("ranking_decision_logs"."user_privacy_bucket" = 'anonymous' or "ranking_decision_logs"."user_privacy_bucket" like 'bucket:%'),
	CONSTRAINT "ranking_decision_logs_version" CHECK ("ranking_decision_logs"."feature_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ranking_feature_vectors" (
	"item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"feature_version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ranking_feature_vectors_item_id_revision_pk" PRIMARY KEY("item_id","revision"),
	CONSTRAINT "ranking_feature_vectors_revision" CHECK ("ranking_feature_vectors"."revision" >= 0),
	CONSTRAINT "ranking_feature_vectors_version" CHECK ("ranking_feature_vectors"."feature_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "ranking_decision_logs_time_idx" ON "ranking_decision_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "ranking_decision_logs_retention_idx" ON "ranking_decision_logs" USING btree ("retain_until");--> statement-breakpoint
CREATE INDEX "ranking_decision_logs_bucket_idx" ON "ranking_decision_logs" USING btree ("user_privacy_bucket","timestamp");--> statement-breakpoint
CREATE INDEX "ranking_feature_vectors_updated_idx" ON "ranking_feature_vectors" USING btree ("updated_at");