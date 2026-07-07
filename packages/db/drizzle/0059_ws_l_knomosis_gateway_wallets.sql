-- WS-L Knomosis gateway, wallets, and receipts (SPEC §22.2, §23.5;
-- docs/planning/13-knomosis-and-wallets.md).
--
-- Part 1 — wallet_accounts lifecycle upgrade (WS-L.2.5a/b/c-1): the unlink
-- states become active → pending_unlink → finalized (row retained for audit),
-- and the risk ladder becomes pending/normal/elevated/high with the FAIL-CLOSED
-- `pending` default (high-value actions stay gated until the first compliance
-- assessment).  The enums are rebuilt with an explicit value mapping (rename →
-- create → USING cast → drop) so the migration is transaction-safe and the old
-- values translate deterministically.
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "unlink_state" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "wallet"."unlink_state" RENAME TO "unlink_state_old";--> statement-breakpoint
CREATE TYPE "wallet"."unlink_state" AS ENUM('active', 'pending_unlink', 'finalized');--> statement-breakpoint
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "unlink_state" TYPE "wallet"."unlink_state" USING (
	CASE "unlink_state"::text
		WHEN 'linked' THEN 'active'
		WHEN 'unlink_requested' THEN 'pending_unlink'
		WHEN 'unlinked' THEN 'finalized'
	END
)::"wallet"."unlink_state";--> statement-breakpoint
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "unlink_state" SET DEFAULT 'active';--> statement-breakpoint
DROP TYPE "wallet"."unlink_state_old";--> statement-breakpoint
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "risk_state" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "wallet"."wallet_risk_state" RENAME TO "wallet_risk_state_old";--> statement-breakpoint
CREATE TYPE "wallet"."wallet_risk_state" AS ENUM('pending', 'normal', 'elevated', 'high');--> statement-breakpoint
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "risk_state" TYPE "wallet"."wallet_risk_state" USING (
	CASE "risk_state"::text
		WHEN 'none' THEN 'normal'
		WHEN 'flagged' THEN 'elevated'
		WHEN 'blocked' THEN 'high'
	END
)::"wallet"."wallet_risk_state";--> statement-breakpoint
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "risk_state" SET DEFAULT 'pending';--> statement-breakpoint
DROP TYPE "wallet"."wallet_risk_state_old";--> statement-breakpoint
ALTER TABLE "wallet"."wallet_accounts" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "wallet"."wallet_accounts" ADD COLUMN "unlink_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallet"."wallet_accounts" ADD COLUMN "unlink_finalize_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallet"."wallet_accounts" ADD COLUMN "unlinked_at" timestamp with time zone;--> statement-breakpoint
-- Backfill the new lifecycle timestamps for wallets caught mid-unlink by this
-- migration (WS-L.2.5b/d).  A `pending_unlink` row (legacy `unlink_requested`)
-- with a NULL `unlink_finalize_after` is invisible to the finalization sweep
-- (which selects `unlink_finalize_after <= now`) and would be STUCK forever, and
-- a `finalized` row (legacy `unlinked`) with a NULL `unlinked_at` reads as
-- "unlinked at epoch 0" and BYPASSES the relink cooldown.  Anchor both to the
-- migration instant (conservative: pending rows finalize on the next sweep; the
-- cooldown runs from migration time).
UPDATE "wallet"."wallet_accounts" SET "unlink_requested_at" = now(), "unlink_finalize_after" = now() WHERE "unlink_state" = 'pending_unlink' AND "unlink_finalize_after" IS NULL;--> statement-breakpoint
UPDATE "wallet"."wallet_accounts" SET "unlinked_at" = now() WHERE "unlink_state" = 'finalized' AND "unlinked_at" IS NULL;--> statement-breakpoint
-- Part 2 — WS-L audit taxonomy additions (shared/schemas/audit.ts mirror).
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'wallet_label_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'knomosis_killswitch_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'knomosis_preflight';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'knomosis_action_submit';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'knomosis_config_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'governance_mode_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'governance_sim_action';--> statement-breakpoint
-- Part 3 — the knomosis-gateway bounded-context tables (isolation: soft room
-- refs only; hard FKs only to public.users / intra-context; every table is
-- classified in packages/db/src/isolation.ts).
CREATE TYPE "knomosis"."knomosis_environment" AS ENUM('local', 'testnet', 'capped_production', 'mature_production');--> statement-breakpoint
CREATE TYPE "knomosis"."knomosis_deployment_status" AS ENUM('provisioning', 'active', 'frozen', 'retired');--> statement-breakpoint
CREATE TYPE "knomosis"."knomosis_event_source" AS ENUM('chain', 'gateway');--> statement-breakpoint
CREATE TYPE "knomosis"."knomosis_reorg_state" AS ENUM('pending', 'confirmed', 'reorged');--> statement-breakpoint
CREATE TYPE "knomosis"."knomosis_action_type" AS ENUM('proposal_sign', 'treasury_deposit', 'grant_payout', 'charter_update', 'bounty_contribution', 'steward_rotation');--> statement-breakpoint
CREATE TYPE "knomosis"."knomosis_submission_state" AS ENUM('submitted', 'accepted', 'settled', 'finalized', 'challenged', 'reverted', 'frozen', 'failed');--> statement-breakpoint
CREATE TYPE "knomosis"."knomosis_reconciliation_state" AS ENUM('pending', 'matched', 'mismatch', 'halted_unsupported_version');--> statement-breakpoint
CREATE TYPE "knomosis"."governance_proposal_type" AS ENUM('charter_update', 'bounty', 'capped_grant');--> statement-breakpoint
CREATE TYPE "knomosis"."proposal_preflight_state" AS ENUM('pending', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "knomosis"."proposal_voting_state" AS ENUM('open', 'passed', 'rejected', 'quorum_not_met');--> statement-breakpoint
CREATE TYPE "knomosis"."proposal_challenge_state" AS ENUM('none', 'open', 'upheld', 'dismissed');--> statement-breakpoint
CREATE TYPE "knomosis"."proposal_execution_state" AS ENUM('not_executed', 'timelocked', 'executed', 'blocked');--> statement-breakpoint
CREATE TYPE "knomosis"."knomosis_reconciliation_outcome" AS ENUM('match', 'mismatch', 'halted_unsupported_version', 'halted_event_gap');--> statement-breakpoint
CREATE TYPE "knomosis"."knomosis_divergence_severity" AS ENUM('informational', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "knomosis"."knomosis_receipt_kind" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TABLE "knomosis"."knomosis_deployment" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"environment" "knomosis"."knomosis_environment" NOT NULL,
	"chain_id" integer NOT NULL,
	"l1_bridge_address" text NOT NULL,
	"runtime_endpoint_ref" text NOT NULL,
	"contract_manifest_hash" text NOT NULL,
	"pinned_knomosis_commit" text NOT NULL,
	"status" "knomosis"."knomosis_deployment_status" DEFAULT 'provisioning' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knomosis_deployment_bridge_addr_chk" CHECK ("l1_bridge_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "knomosis_deployment_manifest_hash_chk" CHECK ("contract_manifest_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "knomosis_deployment_commit_chk" CHECK ("pinned_knomosis_commit" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knomosis_deployment_env_chain_idx" ON "knomosis"."knomosis_deployment" USING btree ("environment", "chain_id");--> statement-breakpoint
CREATE TABLE "knomosis"."on_chain_event" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"block_number" bigint,
	"tx_hash" text,
	"log_index" integer,
	"event_type" text NOT NULL,
	"decoded_payload" jsonb NOT NULL,
	"event_source" "knomosis"."knomosis_event_source" NOT NULL,
	"gateway_seq" bigint,
	"gateway_index" integer,
	"reorg_state" "knomosis"."knomosis_reorg_state" DEFAULT 'pending' NOT NULL,
	"reorg_detected_at" timestamp with time zone,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "on_chain_event_source_coords_chk" CHECK (
		("event_source" = 'chain' AND "block_number" IS NOT NULL AND "tx_hash" IS NOT NULL AND "log_index" IS NOT NULL)
		OR ("event_source" = 'gateway' AND "gateway_seq" IS NOT NULL AND "gateway_index" IS NOT NULL)
	)
);
--> statement-breakpoint
ALTER TABLE "knomosis"."on_chain_event" ADD CONSTRAINT "on_chain_event_deployment_fk" FOREIGN KEY ("deployment_id") REFERENCES "knomosis"."knomosis_deployment"("deployment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "on_chain_event_chain_key_idx" ON "knomosis"."on_chain_event" USING btree ("deployment_id", "tx_hash", "log_index") WHERE event_source = 'chain';--> statement-breakpoint
CREATE UNIQUE INDEX "on_chain_event_gateway_key_idx" ON "knomosis"."on_chain_event" USING btree ("deployment_id", "gateway_seq", "gateway_index") WHERE event_source = 'gateway';--> statement-breakpoint
CREATE INDEX "on_chain_event_order_idx" ON "knomosis"."on_chain_event" USING btree ("deployment_id", "block_number", "log_index");--> statement-breakpoint
CREATE INDEX "on_chain_event_tx_idx" ON "knomosis"."on_chain_event" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "on_chain_event_type_idx" ON "knomosis"."on_chain_event" USING btree ("event_type", "deployment_id");--> statement-breakpoint
CREATE TABLE "knomosis"."knomosis_action_record" (
	"action_record_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"action_type" "knomosis"."knomosis_action_type" NOT NULL,
	"room_id" uuid NOT NULL,
	"actor_wallet_account_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"typed_data_hash" text NOT NULL,
	"signed_action" jsonb NOT NULL,
	"submission_state" "knomosis"."knomosis_submission_state" DEFAULT 'submitted' NOT NULL,
	"failure_reason" text,
	"indexed_event_ref" uuid,
	"reconciliation_state" "knomosis"."knomosis_reconciliation_state" DEFAULT 'pending' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knomosis_action_hashes_chk" CHECK ("payload_hash" ~ '^0x[0-9a-f]{64}$' AND "typed_data_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "knomosis"."knomosis_action_record" ADD CONSTRAINT "knomosis_action_deployment_fk" FOREIGN KEY ("deployment_id") REFERENCES "knomosis"."knomosis_deployment"("deployment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."knomosis_action_record" ADD CONSTRAINT "knomosis_action_wallet_fk" FOREIGN KEY ("actor_wallet_account_id") REFERENCES "wallet"."wallet_accounts"("wallet_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."knomosis_action_record" ADD CONSTRAINT "knomosis_action_user_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."knomosis_action_record" ADD CONSTRAINT "knomosis_action_event_fk" FOREIGN KEY ("indexed_event_ref") REFERENCES "knomosis"."on_chain_event"("event_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knomosis_action_idem_idx" ON "knomosis"."knomosis_action_record" USING btree ("actor_user_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX "knomosis_action_room_idx" ON "knomosis"."knomosis_action_record" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "knomosis_action_state_idx" ON "knomosis"."knomosis_action_record" USING btree ("submission_state", "deployment_id");--> statement-breakpoint
CREATE TABLE "knomosis"."knomosis_action_nonce" (
	"user_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"nonce" numeric(78, 0) NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knomosis_action_nonce_pk" PRIMARY KEY ("user_id", "deployment_id", "nonce")
);
--> statement-breakpoint
ALTER TABLE "knomosis"."knomosis_action_nonce" ADD CONSTRAINT "knomosis_nonce_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."knomosis_action_nonce" ADD CONSTRAINT "knomosis_nonce_deployment_fk" FOREIGN KEY ("deployment_id") REFERENCES "knomosis"."knomosis_deployment"("deployment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "knomosis"."wallet_actor_mapping" (
	"wallet_account_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_actor_mapping_pk" PRIMARY KEY ("wallet_account_id", "deployment_id")
);
--> statement-breakpoint
ALTER TABLE "knomosis"."wallet_actor_mapping" ADD CONSTRAINT "wallet_actor_wallet_fk" FOREIGN KEY ("wallet_account_id") REFERENCES "wallet"."wallet_accounts"("wallet_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."wallet_actor_mapping" ADD CONSTRAINT "wallet_actor_deployment_fk" FOREIGN KEY ("deployment_id") REFERENCES "knomosis"."knomosis_deployment"("deployment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "knomosis"."governance_proposal" (
	"proposal_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"proposer_user_id" uuid NOT NULL,
	"proposal_type" "knomosis"."governance_proposal_type" NOT NULL,
	"title" text NOT NULL,
	"plain_language_summary" text NOT NULL,
	"requested_amount" numeric(78, 0),
	"asset" text,
	"recipient_ref" text,
	"conflict_disclosures" text,
	"risk_assessment" text NOT NULL,
	"requested_action" jsonb NOT NULL,
	"expected_deliverable" text NOT NULL,
	"preflight_state" "knomosis"."proposal_preflight_state" DEFAULT 'pending' NOT NULL,
	"voting_state" "knomosis"."proposal_voting_state" DEFAULT 'open' NOT NULL,
	"challenge_state" "knomosis"."proposal_challenge_state" DEFAULT 'none' NOT NULL,
	"execution_state" "knomosis"."proposal_execution_state" DEFAULT 'not_executed' NOT NULL,
	"simulation_mode" boolean DEFAULT true NOT NULL,
	"executable_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	CONSTRAINT "governance_proposal_amount_chk" CHECK ("requested_amount" IS NULL OR "requested_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "knomosis"."governance_proposal" ADD CONSTRAINT "governance_proposal_proposer_fk" FOREIGN KEY ("proposer_user_id") REFERENCES "public"."users"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "governance_proposal_room_idx" ON "knomosis"."governance_proposal" USING btree ("room_id", "created_at");--> statement-breakpoint
CREATE TABLE "knomosis"."governance_proposal_vote" (
	"proposal_id" uuid NOT NULL,
	"voter_user_id" uuid NOT NULL,
	"choice" text NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_proposal_vote_pk" PRIMARY KEY ("proposal_id", "voter_user_id"),
	CONSTRAINT "governance_proposal_vote_choice_chk" CHECK ("choice" IN ('approve', 'reject', 'abstain'))
);
--> statement-breakpoint
ALTER TABLE "knomosis"."governance_proposal_vote" ADD CONSTRAINT "governance_vote_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "knomosis"."governance_proposal"("proposal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_proposal_vote" ADD CONSTRAINT "governance_vote_voter_fk" FOREIGN KEY ("voter_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "knomosis"."governance_signature" (
	"signature_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_account_id" uuid NOT NULL,
	"signature_type" text NOT NULL,
	"typed_data_hash" text NOT NULL,
	"signature_ref" text NOT NULL,
	"weight_snapshot" numeric,
	"eligibility_reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_signature_type_chk" CHECK ("signature_type" IN ('eip712_ecdsa', 'eip712_eip1271'))
);
--> statement-breakpoint
ALTER TABLE "knomosis"."governance_signature" ADD CONSTRAINT "governance_signature_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "knomosis"."governance_proposal"("proposal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_signature" ADD CONSTRAINT "governance_signature_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."governance_signature" ADD CONSTRAINT "governance_signature_wallet_fk" FOREIGN KEY ("wallet_account_id") REFERENCES "wallet"."wallet_accounts"("wallet_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_signature_unique_idx" ON "knomosis"."governance_signature" USING btree ("proposal_id", "wallet_account_id");--> statement-breakpoint
CREATE TABLE "knomosis"."sim_treasury" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"balances" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knomosis"."sim_treasury_entry" (
	"entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"asset" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"actor_user_id" uuid,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_treasury_entry_kind_chk" CHECK ("kind" IN ('deposit', 'grant_execution')),
	CONSTRAINT "sim_treasury_entry_amount_chk" CHECK ("amount" >= 0),
	CONSTRAINT "sim_treasury_entry_asset_chk" CHECK ("asset" ~ '^SIM-[A-Z0-9]{1,28}$')
);
--> statement-breakpoint
ALTER TABLE "knomosis"."sim_treasury_entry" ADD CONSTRAINT "sim_treasury_entry_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."sim_treasury_entry" ADD CONSTRAINT "sim_treasury_entry_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "knomosis"."governance_proposal"("proposal_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_treasury_entry_room_idx" ON "knomosis"."sim_treasury_entry" USING btree ("room_id", "created_at");--> statement-breakpoint
CREATE TABLE "knomosis"."governance_audit_log" (
	"entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"actor_user_id" uuid,
	"action_details" jsonb NOT NULL,
	"simulation_mode" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knomosis"."governance_audit_log" ADD CONSTRAINT "governance_audit_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "governance_audit_log_room_idx" ON "knomosis"."governance_audit_log" USING btree ("room_id", "created_at", "entry_id");--> statement-breakpoint
-- WS-L.4.1f append-only enforcement: no DELETE ever; the ONLY permitted UPDATE
-- is the right-to-erasure NULLing of `actor_user_id` (the ON DELETE SET NULL
-- cascade above), mirroring the WS-J moderation_audit trigger.
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
	  OR (NEW."actor_user_id"  IS DISTINCT FROM OLD."actor_user_id" AND NEW."actor_user_id" IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'governance_audit_log is append-only (only right-to-erasure NULLing of actor_user_id is permitted)';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "governance_audit_no_mutate_trg" BEFORE UPDATE OR DELETE ON "knomosis"."governance_audit_log" FOR EACH ROW EXECUTE FUNCTION "knomosis"."governance_audit_no_mutate"();--> statement-breakpoint
CREATE TABLE "knomosis"."knomosis_reconciliation_result" (
	"result_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_ref" text NOT NULL,
	"outcome" "knomosis"."knomosis_reconciliation_outcome" NOT NULL,
	"severity" "knomosis"."knomosis_divergence_severity",
	"details" jsonb NOT NULL,
	"low_watermark_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knomosis"."knomosis_reconciliation_result" ADD CONSTRAINT "knomosis_reconciliation_deployment_fk" FOREIGN KEY ("deployment_id") REFERENCES "knomosis"."knomosis_deployment"("deployment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knomosis_reconciliation_entity_idx" ON "knomosis"."knomosis_reconciliation_result" USING btree ("entity_type", "entity_ref", "created_at");--> statement-breakpoint
CREATE TABLE "knomosis"."knomosis_receipt" (
	"receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_record_id" uuid NOT NULL,
	"kind" "knomosis"."knomosis_receipt_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"summary_payload_hash" text NOT NULL,
	"owner_user_id" uuid,
	"final_state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knomosis_receipt_owner_chk" CHECK (("kind" = 'private' AND "owner_user_id" IS NOT NULL) OR ("kind" = 'public' AND "owner_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "knomosis"."knomosis_receipt" ADD CONSTRAINT "knomosis_receipt_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knomosis_receipt_action_kind_idx" ON "knomosis"."knomosis_receipt" USING btree ("action_record_id", "kind");--> statement-breakpoint
CREATE TABLE "knomosis"."comprehension_result" (
	"user_id" uuid NOT NULL,
	"quiz_version" text NOT NULL,
	"passed" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"passed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comprehension_result_pk" PRIMARY KEY ("user_id", "quiz_version")
);
--> statement-breakpoint
CREATE TABLE "knomosis"."knomosis_gateway_cursor" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"seq" numeric NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knomosis"."comprehension_result" ADD CONSTRAINT "comprehension_result_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
