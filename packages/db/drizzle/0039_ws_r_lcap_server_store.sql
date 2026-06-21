CREATE TABLE "lcap_acceptance" (
	"room_id" text NOT NULL,
	"seq" integer NOT NULL,
	"cid" text NOT NULL,
	CONSTRAINT "lcap_acceptance_room_id_seq_pk" PRIMARY KEY("room_id","seq")
);
--> statement-breakpoint
CREATE TABLE "lcap_device_seq" (
	"device_key_id" text NOT NULL,
	"device_seq" integer NOT NULL,
	"cid" text NOT NULL,
	CONSTRAINT "lcap_device_seq_device_key_id_device_seq_pk" PRIMARY KEY("device_key_id","device_seq")
);
--> statement-breakpoint
CREATE TABLE "lcap_fork_evidence" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"author_device_key_id" text NOT NULL,
	"device_seq" integer NOT NULL,
	"existing_cid" text NOT NULL,
	"conflicting_cid" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lcap_objects" (
	"cid" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lcap_acceptance_cid_uq" ON "lcap_acceptance" USING btree ("cid");