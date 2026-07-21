-- WS-N.1.1f — KYC verification standing (bot-prevention layer 3).  One row per
-- user, CASCADE-deleted with the account; ONLY an opaque evidence/partner
-- reference is stored (identity documents and PII never enter the platform).
-- `verified` is the single state the compliance engine's kycLevel maps to
-- 'kyc_partner'; everything else fails closed to 'none'.  The audit vocabulary
-- gains the reviewer-decision event type.
CREATE TYPE "compliance"."kyc_verification_status" AS ENUM('pending', 'verified', 'revoked');--> statement-breakpoint
CREATE TABLE "compliance"."kyc_verification" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" "compliance"."kyc_verification_status" DEFAULT 'pending' NOT NULL,
	"evidence_ref" text,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "compliance"."kyc_verification" ADD CONSTRAINT "kyc_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance"."kyc_verification" ADD CONSTRAINT "kyc_verified_by_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'kyc_verification_change';
