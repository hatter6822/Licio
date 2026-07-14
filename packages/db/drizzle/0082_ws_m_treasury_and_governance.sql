-- WS-M — treasury and governance (SPEC §22.2, §17.4-17.7;
-- docs/planning/14-treasury-and-governance.md).  The real-asset layer over the
-- shipped WS-L.4 simulation + WS-U governance substrate, entirely inside the
-- isolated `knomosis` bounded context: room references stay SOFT (bare uuid,
-- no FK), the only outbound hard FKs point at `public.users` (the identity
-- root) or stay within wallet/knomosis — the structural "no pay-to-rank"
-- guarantee (WS-D.3.2).  Monetary amounts are numeric(78,0) minor units.
--
-- Shipped-table evolutions (never parallel tables — the plan's reconciliation
-- rule): `governance_proposal` gains the production lifecycle (law-pack pin,
-- category, deliberation/voting/challenge windows, tally snapshot) plus three
-- proposal types and the draft/deliberation/escalated/expired enum values;
-- `governance_signature` gains purpose/choice/nonce with one-vote-per-user and
-- single-use-nonce partial uniques; `governance_audit_log` gains the per-room
-- integrity-hash chain (fork-proof via parent/genesis partial uniques, and the
-- append-only trigger is EXTENDED to freeze the new columns); `room_law_pack`
-- gains hash commitment, fixtures, review state, and publish-immutability.
--
-- New tables: room_governance_profile, governance_charter_version (append-only),
-- room_treasury, treasury_reservation, payment_intent, treasury_grant,
-- action_budget, delegation_record, governance_challenge,
-- treasury_reconciliation_snapshot (append-only), room_readiness_attestation.
ALTER TYPE "knomosis"."governance_proposal_type" ADD VALUE IF NOT EXISTS 'steward_rotation';--> statement-breakpoint
ALTER TYPE "knomosis"."governance_proposal_type" ADD VALUE IF NOT EXISTS 'law_pack_upgrade';--> statement-breakpoint
ALTER TYPE "knomosis"."governance_proposal_type" ADD VALUE IF NOT EXISTS 'treasury_policy_update';--> statement-breakpoint
ALTER TYPE "knomosis"."proposal_voting_state" ADD VALUE IF NOT EXISTS 'draft';--> statement-breakpoint
ALTER TYPE "knomosis"."proposal_voting_state" ADD VALUE IF NOT EXISTS 'deliberation';--> statement-breakpoint
ALTER TYPE "knomosis"."proposal_challenge_state" ADD VALUE IF NOT EXISTS 'escalated';--> statement-breakpoint
ALTER TYPE "knomosis"."proposal_execution_state" ADD VALUE IF NOT EXISTS 'expired';--> statement-breakpoint
CREATE TYPE "knomosis"."treasury_freeze_state" AS ENUM('active', 'frozen');--> statement-breakpoint
CREATE TYPE "knomosis"."treasury_reconciliation_state" AS ENUM('synced', 'pending', 'divergent');--> statement-breakpoint
CREATE TYPE "knomosis"."payment_target_type" AS ENUM('treasury_deposit', 'bounty_contribution', 'grant_payout', 'steward_compensation');--> statement-breakpoint
CREATE TYPE "knomosis"."payment_execution_state" AS ENUM('created', 'preflighted', 'quoted', 'signed', 'submitted', 'pending', 'confirmed', 'finalized', 'reverted', 'reorged', 'disputed', 'abandoned', 'failed');--> statement-breakpoint
CREATE TYPE "knomosis"."payment_jurisdiction_state" AS ENUM('allowed', 'restricted', 'blocked');--> statement-breakpoint
CREATE TYPE "knomosis"."payment_compliance_state" AS ENUM('pending', 'cleared', 'flagged', 'blocked');--> statement-breakpoint
CREATE TYPE "knomosis"."treasury_reservation_state" AS ENUM('reserved', 'consumed', 'released');--> statement-breakpoint
CREATE TYPE "knomosis"."grant_milestone_state" AS ENUM('none', 'pending', 'in_progress', 'submitted', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "knomosis"."grant_review_state" AS ENUM('pending', 'independent_review', 'cleared', 'flagged');--> statement-breakpoint
CREATE TYPE "knomosis"."grant_payout_state" AS ENUM('not_started', 'scheduled', 'partially_paid', 'paid', 'clawed_back');--> statement-breakpoint
CREATE TYPE "knomosis"."governance_challenge_type" AS ENUM('coi', 'fraud', 'capture', 'legal', 'evidence_defect');--> statement-breakpoint
CREATE TYPE "knomosis"."governance_challenge_record_state" AS ENUM('open', 'upheld', 'dismissed', 'escalated');--> statement-breakpoint
CREATE TYPE "knomosis"."delegation_state" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "knomosis"."treasury_snapshot_result" AS ENUM('synced', 'explained', 'divergent');--> statement-breakpoint
CREATE TYPE "knomosis"."law_pack_audit_state" AS ENUM('draft', 'reviewed', 'audited');--> statement-breakpoint
ALTER TABLE "knomosis"."governance_proposal" ADD COLUMN "law_pack_version_id" uuid;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_proposal" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_proposal" ADD COLUMN "deliberation_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_proposal" ADD COLUMN "voting_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_proposal" ADD COLUMN "challenge_window_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_proposal" ADD COLUMN "tally_snapshot" jsonb;--> statement-breakpoint
CREATE INDEX "governance_proposal_deadline_idx" ON "knomosis"."governance_proposal" ("voting_state", "voting_ends_at");--> statement-breakpoint
ALTER TABLE "knomosis"."governance_signature" ADD COLUMN "purpose" text DEFAULT 'vote' NOT NULL;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_signature" ADD COLUMN "choice" text;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_signature" ADD COLUMN "nonce" text;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_signature" ADD CONSTRAINT "governance_signature_purpose_check" CHECK ("purpose" IN ('vote', 'approval', 'multisig', 'delegation'));--> statement-breakpoint
ALTER TABLE "knomosis"."governance_signature" ADD CONSTRAINT "governance_signature_choice_check" CHECK ("choice" IS NULL OR "choice" IN ('approve', 'reject', 'abstain'));--> statement-breakpoint
CREATE UNIQUE INDEX "governance_signature_one_vote_uq" ON "knomosis"."governance_signature" ("proposal_id", "user_id") WHERE "purpose" = 'vote';--> statement-breakpoint
CREATE UNIQUE INDEX "governance_signature_nonce_uq" ON "knomosis"."governance_signature" ("proposal_id", "nonce") WHERE "nonce" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_audit_log" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_audit_log" ADD COLUMN "integrity_hash" text;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_audit_log" ADD COLUMN "proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_audit_log" ADD COLUMN "treasury_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_audit_chain_parent_uq" ON "knomosis"."governance_audit_log" ("room_id", "prev_hash") WHERE "prev_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_audit_chain_genesis_uq" ON "knomosis"."governance_audit_log" ("room_id") WHERE "prev_hash" IS NULL AND "integrity_hash" IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "knomosis"."governance_audit_no_mutate"() RETURNS trigger AS $$
BEGIN
	IF (TG_OP = 'DELETE') THEN
		RAISE EXCEPTION 'governance_audit_log is append-only (no DELETE)';
	END IF;
	IF ( NEW."entry_id"        IS DISTINCT FROM OLD."entry_id"
	  OR NEW."room_id"         IS DISTINCT FROM OLD."room_id"
	  OR NEW."action_type"     IS DISTINCT FROM OLD."action_type"
	  OR NEW."action_details"  IS DISTINCT FROM OLD."action_details"
	  OR NEW."simulation_mode" IS DISTINCT FROM OLD."simulation_mode"
	  OR NEW."created_at"      IS DISTINCT FROM OLD."created_at"
	  OR NEW."prev_hash"       IS DISTINCT FROM OLD."prev_hash"
	  OR NEW."integrity_hash"  IS DISTINCT FROM OLD."integrity_hash"
	  OR NEW."proposal_id"     IS DISTINCT FROM OLD."proposal_id"
	  OR NEW."treasury_id"     IS DISTINCT FROM OLD."treasury_id"
	  OR (NEW."actor_user_id"  IS DISTINCT FROM OLD."actor_user_id" AND NEW."actor_user_id" IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'governance_audit_log is append-only (only right-to-erasure NULLing of actor_user_id is permitted)';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
ALTER TABLE "knomosis"."room_law_pack" ADD COLUMN "hash_commitment" text;--> statement-breakpoint
ALTER TABLE "knomosis"."room_law_pack" ADD COLUMN "audit_state" "knomosis"."law_pack_audit_state" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "knomosis"."room_law_pack" ADD COLUMN "fixtures" jsonb;--> statement-breakpoint
ALTER TABLE "knomosis"."room_law_pack" ADD COLUMN "human_summary" text;--> statement-breakpoint
ALTER TABLE "knomosis"."room_law_pack" ADD COLUMN "published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "knomosis"."room_law_pack" ADD COLUMN "effective_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knomosis"."room_law_pack" ADD COLUMN "supersedes_law_pack_id" uuid;--> statement-breakpoint
ALTER TABLE "knomosis"."room_law_pack" ADD CONSTRAINT "room_law_pack_hash_check" CHECK ("hash_commitment" IS NULL OR "hash_commitment" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "knomosis"."room_law_pack" ADD CONSTRAINT "room_law_pack_supersedes_fk" FOREIGN KEY ("supersedes_law_pack_id") REFERENCES "knomosis"."room_law_pack"("law_pack_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "knomosis"."room_law_pack_immutable"() RETURNS trigger AS $$
BEGIN
	IF (TG_OP = 'DELETE') THEN
		IF OLD."published" THEN
			RAISE EXCEPTION 'a published law-pack version is retained indefinitely (WS-M.1.3d)';
		END IF;
		RETURN OLD;
	END IF;
	IF OLD."published" AND
	   ( NEW."document"        IS DISTINCT FROM OLD."document"
	  OR NEW."version"         IS DISTINCT FROM OLD."version"
	  OR NEW."hash_commitment" IS DISTINCT FROM OLD."hash_commitment"
	  OR NEW."fixtures"        IS DISTINCT FROM OLD."fixtures"
	  OR NEW."room_id"         IS DISTINCT FROM OLD."room_id"
	  OR NEW."published"       IS DISTINCT FROM OLD."published"
	) THEN
		RAISE EXCEPTION 'a published law-pack version is immutable (WS-M.1.3d); create a new version instead';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "room_law_pack_immutable_trg" BEFORE UPDATE OR DELETE ON "knomosis"."room_law_pack" FOR EACH ROW EXECUTE FUNCTION "knomosis"."room_law_pack_immutable"();--> statement-breakpoint
ALTER TABLE "knomosis"."governance_proposal" ADD CONSTRAINT "governance_proposal_law_pack_fk" FOREIGN KEY ("law_pack_version_id") REFERENCES "knomosis"."room_law_pack"("law_pack_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "knomosis"."governance_charter_version" (
	"charter_version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"sections" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charter_version_min_check" CHECK ("version" >= 1),
	CONSTRAINT "charter_content_hash_check" CHECK ("content_hash" ~ '^0x[0-9a-f]{64}$')
);--> statement-breakpoint
ALTER TABLE "knomosis"."governance_charter_version" ADD CONSTRAINT "charter_version_created_by_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "charter_version_room_version_uq" ON "knomosis"."governance_charter_version" ("room_id", "version");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "knomosis"."charter_version_no_mutate"() RETURNS trigger AS $$
BEGIN
	IF (TG_OP = 'DELETE') THEN
		RAISE EXCEPTION 'governance_charter_version is append-only (no DELETE)';
	END IF;
	IF ( NEW."charter_version_id" IS DISTINCT FROM OLD."charter_version_id"
	  OR NEW."room_id"            IS DISTINCT FROM OLD."room_id"
	  OR NEW."version"            IS DISTINCT FROM OLD."version"
	  OR NEW."sections"           IS DISTINCT FROM OLD."sections"
	  OR NEW."content_hash"       IS DISTINCT FROM OLD."content_hash"
	  OR NEW."created_at"         IS DISTINCT FROM OLD."created_at"
	  OR (NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id" AND NEW."created_by_user_id" IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'governance_charter_version is append-only (only right-to-erasure NULLing of created_by_user_id is permitted)';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "charter_version_no_mutate_trg" BEFORE UPDATE OR DELETE ON "knomosis"."governance_charter_version" FOR EACH ROW EXECUTE FUNCTION "knomosis"."charter_version_no_mutate"();--> statement-breakpoint
CREATE TABLE "knomosis"."room_treasury" (
	"treasury_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"treasury_address" text NOT NULL,
	"accepted_assets" jsonb NOT NULL,
	"balance_snapshot" jsonb,
	"balances_reconciled_at" timestamp with time zone,
	"deposit_limits" jsonb NOT NULL,
	"freeze_state" "knomosis"."treasury_freeze_state" DEFAULT 'active' NOT NULL,
	"freeze_reason" text,
	"pause_flags" jsonb DEFAULT '{"deposits":false,"proposals":false,"executions":false}'::jsonb NOT NULL,
	"reconciliation_state" "knomosis"."treasury_reconciliation_state" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_treasury_address_check" CHECK ("treasury_address" ~ '^0x[0-9a-f]{40}$')
);--> statement-breakpoint
ALTER TABLE "knomosis"."room_treasury" ADD CONSTRAINT "room_treasury_deployment_fk" FOREIGN KEY ("deployment_id") REFERENCES "knomosis"."knomosis_deployment"("deployment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_treasury_room_uq" ON "knomosis"."room_treasury" ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_treasury_address_uq" ON "knomosis"."room_treasury" ("treasury_address");--> statement-breakpoint
CREATE TABLE "knomosis"."room_governance_profile" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"law_pack_id" uuid,
	"charter_version_id" uuid,
	"treasury_id" uuid,
	"quorum_policy_ref" jsonb,
	"threshold_policy_ref" jsonb,
	"timelock_policy_ref" jsonb,
	"freeze_state" "knomosis"."treasury_freeze_state" DEFAULT 'active' NOT NULL,
	"freeze_reason" text,
	"pause_flags" jsonb DEFAULT '{"deposits":false,"proposals":false,"executions":false}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "knomosis"."room_governance_profile" ADD CONSTRAINT "governance_profile_law_pack_fk" FOREIGN KEY ("law_pack_id") REFERENCES "knomosis"."room_law_pack"("law_pack_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."room_governance_profile" ADD CONSTRAINT "governance_profile_charter_fk" FOREIGN KEY ("charter_version_id") REFERENCES "knomosis"."governance_charter_version"("charter_version_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."room_governance_profile" ADD CONSTRAINT "governance_profile_treasury_fk" FOREIGN KEY ("treasury_id") REFERENCES "knomosis"."room_treasury"("treasury_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "knomosis"."treasury_reservation" (
	"reservation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"treasury_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"category" text NOT NULL,
	"asset" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"state" "knomosis"."treasury_reservation_state" DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_reservation_amount_check" CHECK ("amount" > 0)
);--> statement-breakpoint
ALTER TABLE "knomosis"."treasury_reservation" ADD CONSTRAINT "treasury_reservation_treasury_fk" FOREIGN KEY ("treasury_id") REFERENCES "knomosis"."room_treasury"("treasury_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."treasury_reservation" ADD CONSTRAINT "treasury_reservation_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "knomosis"."governance_proposal"("proposal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_reservation_proposal_uq" ON "knomosis"."treasury_reservation" ("proposal_id");--> statement-breakpoint
CREATE INDEX "treasury_reservation_headroom_idx" ON "knomosis"."treasury_reservation" ("treasury_id", "category", "state");--> statement-breakpoint
CREATE TABLE "knomosis"."payment_intent" (
	"payment_intent_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"room_id" uuid NOT NULL,
	"treasury_id" uuid NOT NULL,
	"target_type" "knomosis"."payment_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"jurisdiction_state" "knomosis"."payment_jurisdiction_state" DEFAULT 'blocked' NOT NULL,
	"compliance_state" "knomosis"."payment_compliance_state" DEFAULT 'pending' NOT NULL,
	"execution_state" "knomosis"."payment_execution_state" DEFAULT 'created' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"quote_ref" jsonb,
	"action_record_id" uuid,
	"receipt_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intent_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "payment_intent_retry_check" CHECK ("retry_count" >= 0)
);--> statement-breakpoint
ALTER TABLE "knomosis"."payment_intent" ADD CONSTRAINT "payment_intent_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."payment_intent" ADD CONSTRAINT "payment_intent_treasury_fk" FOREIGN KEY ("treasury_id") REFERENCES "knomosis"."room_treasury"("treasury_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."payment_intent" ADD CONSTRAINT "payment_intent_action_fk" FOREIGN KEY ("action_record_id") REFERENCES "knomosis"."knomosis_action_record"("action_record_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intent_idem_uq" ON "knomosis"."payment_intent" ("user_id", "room_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_intent_room_idx" ON "knomosis"."payment_intent" ("room_id", "created_at");--> statement-breakpoint
CREATE INDEX "payment_intent_state_idx" ON "knomosis"."payment_intent" ("execution_state", "expires_at");--> statement-breakpoint
CREATE INDEX "payment_intent_treasury_idx" ON "knomosis"."payment_intent" ("treasury_id", "target_type");--> statement-breakpoint
CREATE TABLE "knomosis"."treasury_grant" (
	"grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"treasury_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"recipient_ref" text NOT NULL,
	"purpose" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"asset" text NOT NULL,
	"milestones" jsonb NOT NULL,
	"milestone_state" "knomosis"."grant_milestone_state" DEFAULT 'none' NOT NULL,
	"review_state" "knomosis"."grant_review_state" DEFAULT 'pending' NOT NULL,
	"payout_state" "knomosis"."grant_payout_state" DEFAULT 'not_started' NOT NULL,
	"audit_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_grant_amount_check" CHECK ("amount" > 0)
);--> statement-breakpoint
ALTER TABLE "knomosis"."treasury_grant" ADD CONSTRAINT "treasury_grant_treasury_fk" FOREIGN KEY ("treasury_id") REFERENCES "knomosis"."room_treasury"("treasury_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."treasury_grant" ADD CONSTRAINT "treasury_grant_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "knomosis"."governance_proposal"("proposal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_grant_proposal_uq" ON "knomosis"."treasury_grant" ("proposal_id");--> statement-breakpoint
CREATE INDEX "treasury_grant_room_idx" ON "knomosis"."treasury_grant" ("room_id", "created_at");--> statement-breakpoint
CREATE TABLE "knomosis"."action_budget" (
	"budget_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"actor_key" text NOT NULL,
	"available_units" bigint DEFAULT 0 NOT NULL,
	"last_refill_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rate_limit_state" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_budget_units_check" CHECK ("available_units" >= 0),
	CONSTRAINT "action_budget_actor_check" CHECK ("actor_key" ~ '^(user|workflow):.+')
);--> statement-breakpoint
CREATE UNIQUE INDEX "action_budget_actor_uq" ON "knomosis"."action_budget" ("room_id", "actor_key");--> statement-breakpoint
CREATE TABLE "knomosis"."delegation_record" (
	"delegation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"delegator_user_id" uuid,
	"delegate_user_id" uuid,
	"scope" jsonb NOT NULL,
	"scope_key" text NOT NULL,
	"state" "knomosis"."delegation_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "delegation_scope_key_check" CHECK ("scope_key" = 'all' OR "scope_key" LIKE 'type:%')
);--> statement-breakpoint
ALTER TABLE "knomosis"."delegation_record" ADD CONSTRAINT "delegation_delegator_fk" FOREIGN KEY ("delegator_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."delegation_record" ADD CONSTRAINT "delegation_delegate_fk" FOREIGN KEY ("delegate_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delegation_active_uq" ON "knomosis"."delegation_record" ("room_id", "delegator_user_id", "scope_key") WHERE "state" = 'active';--> statement-breakpoint
CREATE INDEX "delegation_delegate_idx" ON "knomosis"."delegation_record" ("room_id", "delegate_user_id", "state");--> statement-breakpoint
CREATE TABLE "knomosis"."governance_challenge" (
	"challenge_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"challenger_user_id" uuid,
	"challenge_type" "knomosis"."governance_challenge_type" NOT NULL,
	"description" text NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"state" "knomosis"."governance_challenge_record_state" DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "knomosis"."governance_challenge" ADD CONSTRAINT "governance_challenge_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "knomosis"."governance_proposal"("proposal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_challenge" ADD CONSTRAINT "governance_challenge_challenger_fk" FOREIGN KEY ("challenger_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_challenge" ADD CONSTRAINT "governance_challenge_resolver_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "governance_challenge_proposal_idx" ON "knomosis"."governance_challenge" ("proposal_id", "state");--> statement-breakpoint
CREATE TABLE "knomosis"."treasury_reconciliation_snapshot" (
	"snapshot_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"treasury_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"product_ledger_balance" numeric(78, 0) NOT NULL,
	"receipts_balance" numeric(78, 0) NOT NULL,
	"onchain_observed_balance" numeric(78, 0) NOT NULL,
	"gap" numeric(78, 0) NOT NULL,
	"explanation" jsonb,
	"result" "knomosis"."treasury_snapshot_result" NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_snapshot_explained_check" CHECK ("result" <> 'explained' OR "explanation" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "knomosis"."treasury_reconciliation_snapshot" ADD CONSTRAINT "treasury_snapshot_treasury_fk" FOREIGN KEY ("treasury_id") REFERENCES "knomosis"."room_treasury"("treasury_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treasury_snapshot_treasury_idx" ON "knomosis"."treasury_reconciliation_snapshot" ("treasury_id", "observed_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "knomosis"."treasury_snapshot_no_mutate"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'treasury_reconciliation_snapshot is append-only (WS-M.5.2a)';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "treasury_snapshot_no_mutate_trg" BEFORE UPDATE OR DELETE ON "knomosis"."treasury_reconciliation_snapshot" FOR EACH ROW EXECUTE FUNCTION "knomosis"."treasury_snapshot_no_mutate"();--> statement-breakpoint
CREATE TABLE "knomosis"."room_readiness_attestation" (
	"room_id" uuid NOT NULL,
	"item" text NOT NULL,
	"attested_by_user_id" uuid,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_readiness_attestation_room_id_item_pk" PRIMARY KEY("room_id","item"),
	CONSTRAINT "readiness_attestation_item_check" CHECK ("item" IN ('safety_override_acknowledged', 'external_audit_passed'))
);--> statement-breakpoint
ALTER TABLE "knomosis"."room_readiness_attestation" ADD CONSTRAINT "readiness_attestation_user_fk" FOREIGN KEY ("attested_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
