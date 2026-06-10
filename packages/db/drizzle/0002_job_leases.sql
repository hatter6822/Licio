CREATE TABLE "job_leases" (
	"job_name" text PRIMARY KEY NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"holder" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);
