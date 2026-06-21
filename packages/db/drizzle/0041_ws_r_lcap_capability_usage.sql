CREATE TABLE "lcap_capability_usage" (
	"capability_id" text PRIMARY KEY NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL
);
