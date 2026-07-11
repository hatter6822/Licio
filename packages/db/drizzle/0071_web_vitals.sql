-- WS-P.1.1d Core Web Vitals RUM sink (closes the tracked /v1/telemetry debt:
-- the route previously validated and DISCARDED every batch in every
-- environment).  Two retention classes: `web_vital_samples` is short-lived
-- working data for the rolling-24h p75 (swept ~1h past the window);
-- `web_vital_aggregates` is the durable 90-day trend series behind regression
-- detection.  Privacy: closed enums (CHECKed), route PATTERN only, numeric
-- value — no user identifier, no IP, no attention/behavioral content.
CREATE TABLE "web_vital_samples" (
	"sample_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric" text NOT NULL,
	"device_class" text NOT NULL,
	"connection" text NOT NULL,
	"route" text NOT NULL,
	"value" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "web_vital_samples_metric" CHECK ("web_vital_samples"."metric" in ('LCP', 'INP', 'CLS')),
	CONSTRAINT "web_vital_samples_device" CHECK ("web_vital_samples"."device_class" in ('low', 'mid', 'high', 'unknown')),
	CONSTRAINT "web_vital_samples_connection" CHECK ("web_vital_samples"."connection" in ('slow-2g', '2g', '3g', '4g', 'unknown')),
	CONSTRAINT "web_vital_samples_value" CHECK ("web_vital_samples"."value" >= 0)
);
--> statement-breakpoint
CREATE INDEX "web_vital_samples_created_idx" ON "web_vital_samples" USING btree ("created_at");
--> statement-breakpoint
CREATE TABLE "web_vital_aggregates" (
	"aggregate_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric" text NOT NULL,
	"device_class" text NOT NULL,
	"connection" text NOT NULL,
	"route" text NOT NULL,
	"p75" double precision NOT NULL,
	"sample_count" integer NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	CONSTRAINT "web_vital_aggregates_metric" CHECK ("web_vital_aggregates"."metric" in ('LCP', 'INP', 'CLS')),
	CONSTRAINT "web_vital_aggregates_device" CHECK ("web_vital_aggregates"."device_class" in ('low', 'mid', 'high', 'unknown')),
	CONSTRAINT "web_vital_aggregates_connection" CHECK ("web_vital_aggregates"."connection" in ('slow-2g', '2g', '3g', '4g', 'unknown')),
	CONSTRAINT "web_vital_aggregates_count" CHECK ("web_vital_aggregates"."sample_count" >= 1)
);
--> statement-breakpoint
CREATE INDEX "web_vital_aggregates_metric_idx" ON "web_vital_aggregates" USING btree ("metric","window_end");
