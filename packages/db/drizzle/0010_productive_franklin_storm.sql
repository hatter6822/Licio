ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'invariant_config_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'invariant_promotion_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'mfci_case_action';--> statement-breakpoint
CREATE TABLE "mfci_margins" (
	"margins_ref" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"margins" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfci_margins_ref_len" CHECK (char_length("mfci_margins"."margins_ref") between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "mfci_risk_states" (
	"target_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"score" double precision NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mfci_risk_states_state" CHECK ("mfci_risk_states"."state" in ('normal', 'elevated', 'high', 'severe')),
	CONSTRAINT "mfci_risk_states_reason" CHECK ("mfci_risk_states"."reason" in ('score', 'fiber_cleared', 'analyst_override', 'held_pending_review')),
	CONSTRAINT "mfci_risk_states_score" CHECK ("mfci_risk_states"."score" >= 0)
);
--> statement-breakpoint
CREATE INDEX "mfci_margins_window_idx" ON "mfci_margins" USING btree ("window_start");