-- WS-N — compliance, finance, and distribution readiness (SPEC §17.10, §22.2;
-- docs/planning/15-compliance.md).  The `compliance` bounded context: the
-- jurisdiction policy engine's versioned rows + hash-chained change audit
-- (WS-N.1.1a/g), financial-compliance cases + per-case chained review trails
-- (WS-N.2.1a/c), identity-free region declarations (WS-N.1.1f — §19.1: never
-- geolocation), versioned consumer risk disclosures + acknowledgments
-- (WS-N.1.2d), wallet-risk pins (WS-N.2.2e), SAR/STR records (WS-N.2.1e,
-- counsel-only), and lawful-access requests (WS-N.2.3d).
--
-- Isolation (WS-D.3.2 / §21.5): room/wallet/intent refs are SOFT (no FK); the
-- only outward hard FKs point at public.users.  Chained audit rows store
-- NON-REVERSIBLE actor refs, so right-to-erasure never mutates a hashed
-- column and the chains verify forever.  Fork-proofing mirrors migration
-- 0082: one-child-per-parent + single-genesis partial uniques.
--
-- Deletion posture: the two audit chains are trigger-protected append-only.
-- `compliance_case_audit` additionally honors the SANCTIONED retention path
-- (WS-N.2.1d "deletion is thorough"): DELETE is permitted ONLY inside a
-- transaction that set the `licio.compliance_retention` GUC — the retention
-- job's transaction-scoped key — so casual tampering stays impossible.
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'region_declaration_change';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'compliance_policy_change';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'disclosure_change';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'compliance_config_change';--> statement-breakpoint
CREATE SCHEMA "compliance";--> statement-breakpoint
CREATE TYPE "compliance"."case_trigger_type" AS ENUM('velocity', 'pattern', 'sanctions', 'manual', 'fraud', 'scam', 'impersonation', 'bribery', 'coercion');--> statement-breakpoint
CREATE TYPE "compliance"."case_risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "compliance"."case_review_state" AS ENUM('open', 'assigned', 'investigating', 'resolved', 'escalated');--> statement-breakpoint
CREATE TYPE "compliance"."case_subject_kind" AS ENUM('user', 'room', 'address', 'transaction');--> statement-breakpoint
CREATE TYPE "compliance"."region_declaration_status" AS ENUM('pending', 'verified', 'revoked');--> statement-breakpoint
CREATE TYPE "compliance"."region_declaration_verification" AS ENUM('unverified', 'reviewer_verified');--> statement-breakpoint
CREATE TYPE "compliance"."sar_status" AS ENUM('draft', 'approved', 'filed');--> statement-breakpoint
CREATE TYPE "compliance"."lawful_access_basis" AS ENUM('warrant', 'subpoena', 'court_order', 'emergency');--> statement-breakpoint
CREATE TYPE "compliance"."lawful_access_status" AS ENUM('received', 'under_review', 'approved', 'denied', 'produced');--> statement-breakpoint
CREATE TABLE "compliance"."jurisdiction_feature_policy" (
	"policy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_or_region" text NOT NULL,
	"feature_flags" jsonb NOT NULL,
	"asset_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"age_gate_policy" jsonb NOT NULL,
	"kyc_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"disclosure_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"legal_approval_ref" text,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "jfp_region_effective_uq" ON "compliance"."jurisdiction_feature_policy" ("country_or_region", "effective_at");--> statement-breakpoint
CREATE INDEX "jfp_region_idx" ON "compliance"."jurisdiction_feature_policy" ("country_or_region");--> statement-breakpoint
CREATE TABLE "compliance"."jurisdiction_policy_audit" (
	"change_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_key" text DEFAULT 'jurisdiction-policy' NOT NULL,
	"policy_id" uuid NOT NULL,
	"country_or_region" text NOT NULL,
	"change_type" text NOT NULL,
	"changed_by_ref" text NOT NULL,
	"previous_value" jsonb,
	"new_value" jsonb NOT NULL,
	"reason" text NOT NULL,
	"approval_ref" text,
	"prev_hash" text,
	"integrity_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jpa_chain_key_check" CHECK ("chain_key" = 'jurisdiction-policy'),
	CONSTRAINT "jpa_change_type_check" CHECK ("change_type" IN ('create', 'update', 'deactivate'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "jpa_chain_parent_uq" ON "compliance"."jurisdiction_policy_audit" ("chain_key", "prev_hash") WHERE "prev_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "jpa_chain_genesis_uq" ON "compliance"."jurisdiction_policy_audit" ("chain_key") WHERE "prev_hash" IS NULL;--> statement-breakpoint
CREATE INDEX "jpa_policy_idx" ON "compliance"."jurisdiction_policy_audit" ("policy_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "compliance"."jurisdiction_policy_audit_no_mutate"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'jurisdiction_policy_audit is append-only (no UPDATE/DELETE; actor refs are non-reversible, so erasure never needs to touch this table)';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "jurisdiction_policy_audit_append_only" BEFORE UPDATE OR DELETE ON "compliance"."jurisdiction_policy_audit" FOR EACH ROW EXECUTE FUNCTION "compliance"."jurisdiction_policy_audit_no_mutate"();--> statement-breakpoint
CREATE TABLE "compliance"."financial_compliance_case" (
	"case_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id_or_room_id" text,
	"subject_kind" "compliance"."case_subject_kind" NOT NULL,
	"trigger_type" "compliance"."case_trigger_type" NOT NULL,
	"risk_level" "compliance"."case_risk_level" NOT NULL,
	"partner_case_ref" text,
	"review_state" "compliance"."case_review_state" DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"resolution" jsonb,
	"retention_policy" jsonb NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "compliance"."financial_compliance_case" ADD CONSTRAINT "fcc_assigned_to_users_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fcc_review_state_idx" ON "compliance"."financial_compliance_case" ("review_state");--> statement-breakpoint
CREATE INDEX "fcc_trigger_idx" ON "compliance"."financial_compliance_case" ("trigger_type");--> statement-breakpoint
CREATE INDEX "fcc_subject_created_idx" ON "compliance"."financial_compliance_case" ("user_id_or_room_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fcc_idempotency_uq" ON "compliance"."financial_compliance_case" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "compliance"."compliance_case_audit" (
	"audit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_ref" text NOT NULL,
	"before_state" text,
	"after_state" text,
	"note" text,
	"prev_hash" text,
	"integrity_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "compliance"."compliance_case_audit" ADD CONSTRAINT "cca_case_fk" FOREIGN KEY ("case_id") REFERENCES "compliance"."financial_compliance_case"("case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cca_chain_parent_uq" ON "compliance"."compliance_case_audit" ("case_id", "prev_hash") WHERE "prev_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cca_chain_genesis_uq" ON "compliance"."compliance_case_audit" ("case_id") WHERE "prev_hash" IS NULL;--> statement-breakpoint
CREATE INDEX "cca_case_idx" ON "compliance"."compliance_case_audit" ("case_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "compliance"."compliance_case_audit_no_mutate"() RETURNS trigger AS $$
BEGIN
	IF (TG_OP = 'DELETE') THEN
		-- The SANCTIONED retention path (WS-N.2.1d): the retention job sets the
		-- transaction-scoped GUC before its thorough delete; every other DELETE
		-- (a compromised connection, an ad-hoc query) is rejected.
		IF current_setting('licio.compliance_retention', true) = 'on' THEN
			RETURN OLD;
		END IF;
		RAISE EXCEPTION 'compliance_case_audit is append-only (DELETE only via the sanctioned retention path)';
	END IF;
	RAISE EXCEPTION 'compliance_case_audit is append-only (no UPDATE; actor refs are non-reversible, so erasure never needs to touch this table)';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "compliance_case_audit_append_only" BEFORE UPDATE OR DELETE ON "compliance"."compliance_case_audit" FOR EACH ROW EXECUTE FUNCTION "compliance"."compliance_case_audit_no_mutate"();--> statement-breakpoint
CREATE TABLE "compliance"."region_declaration" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"declared_region" text NOT NULL,
	"status" "compliance"."region_declaration_status" DEFAULT 'pending' NOT NULL,
	"verification_level" "compliance"."region_declaration_verification" DEFAULT 'unverified' NOT NULL,
	"evidence_ref" text,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "compliance"."region_declaration" ADD CONSTRAINT "rd_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance"."region_declaration" ADD CONSTRAINT "rd_verified_by_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "compliance"."disclosure_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"disclosure_id" text NOT NULL,
	"region" text NOT NULL,
	"version" integer NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"content_md" text NOT NULL,
	"requires_acknowledgment" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "dv_identity_uq" ON "compliance"."disclosure_version" ("disclosure_id", "region", "version", "locale");--> statement-breakpoint
CREATE INDEX "dv_region_idx" ON "compliance"."disclosure_version" ("region");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "compliance"."disclosure_version_no_mutate"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'disclosure_version is publish-immutable (a correction is a NEW version; old versions are retained for audit — WS-N.1.2d)';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "disclosure_version_immutable" BEFORE UPDATE OR DELETE ON "compliance"."disclosure_version" FOR EACH ROW EXECUTE FUNCTION "compliance"."disclosure_version_no_mutate"();--> statement-breakpoint
CREATE TABLE "compliance"."disclosure_acknowledgment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"disclosure_id" text NOT NULL,
	"version" integer NOT NULL,
	"region" text NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "compliance"."disclosure_acknowledgment" ADD CONSTRAINT "da_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "da_user_version_uq" ON "compliance"."disclosure_acknowledgment" ("user_id", "disclosure_id", "version", "region") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "compliance"."disclosure_acknowledgment_no_mutate"() RETURNS trigger AS $$
BEGIN
	IF (TG_OP = 'DELETE') THEN
		RAISE EXCEPTION 'disclosure_acknowledgment is append-only (consent evidence; erasure anonymizes, never deletes)';
	END IF;
	IF ( NEW."id"              IS DISTINCT FROM OLD."id"
	  OR NEW."disclosure_id"   IS DISTINCT FROM OLD."disclosure_id"
	  OR NEW."version"         IS DISTINCT FROM OLD."version"
	  OR NEW."region"          IS DISTINCT FROM OLD."region"
	  OR NEW."acknowledged_at" IS DISTINCT FROM OLD."acknowledged_at"
	  OR (NEW."user_id"        IS DISTINCT FROM OLD."user_id" AND NEW."user_id" IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'disclosure_acknowledgment is append-only (only right-to-erasure NULLing of user_id is permitted)';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "disclosure_acknowledgment_append_only" BEFORE UPDATE OR DELETE ON "compliance"."disclosure_acknowledgment" FOR EACH ROW EXECUTE FUNCTION "compliance"."disclosure_acknowledgment_no_mutate"();--> statement-breakpoint
CREATE TABLE "compliance"."wallet_risk_pin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"pinned_by_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_ref" text
);--> statement-breakpoint
CREATE UNIQUE INDEX "wrp_active_uq" ON "compliance"."wallet_risk_pin" ("wallet_account_id") WHERE "released_at" IS NULL;--> statement-breakpoint
CREATE TABLE "compliance"."sar_report" (
	"sar_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"status" "compliance"."sar_status" DEFAULT 'draft' NOT NULL,
	"narrative" text NOT NULL,
	"filing_ref" text,
	"filed_at" timestamp with time zone,
	"partner_filed" boolean DEFAULT false NOT NULL,
	"created_by_ref" text NOT NULL,
	"approved_by_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "compliance"."sar_report" ADD CONSTRAINT "sar_case_fk" FOREIGN KEY ("case_id") REFERENCES "compliance"."financial_compliance_case"("case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sar_case_idx" ON "compliance"."sar_report" ("case_id");--> statement-breakpoint
CREATE TABLE "compliance"."lawful_access_request" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"legal_basis" "compliance"."lawful_access_basis" NOT NULL,
	"scope" jsonb NOT NULL,
	"contact" text NOT NULL,
	"status" "compliance"."lawful_access_status" DEFAULT 'received' NOT NULL,
	"review_note" text,
	"reviewed_by_ref" text,
	"production_summary" text,
	"user_notified_at" timestamp with time zone,
	"case_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "compliance"."lawful_access_request" ADD CONSTRAINT "lar_case_fk" FOREIGN KEY ("case_id") REFERENCES "compliance"."financial_compliance_case"("case_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lar_status_idx" ON "compliance"."lawful_access_request" ("status");
