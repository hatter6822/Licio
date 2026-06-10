CREATE SCHEMA "wallet";
--> statement-breakpoint
CREATE TYPE "public"."audit_event_type" AS ENUM('login_success', 'login_failure', 'session_create', 'session_revoke', 'auth_method_add', 'auth_method_remove', 'mfa_enroll', 'mfa_verify', 'mfa_disable', 'privacy_setting_change', 'export_request', 'export_download', 'deletion_request', 'deletion_cancel', 'deletion_complete', 'attention_delete', 'wallet_link', 'wallet_unlink', 'role_change', 'suspicious_login', 'account_lockout', 'authz_denied');--> statement-breakpoint
CREATE TYPE "public"."deletion_state" AS ENUM('grace_period', 'deleted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."export_job_state" AS ENUM('queued', 'processing', 'completed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."auth_method" AS ENUM('webauthn', 'email_otp', 'wallet');--> statement-breakpoint
CREATE TYPE "public"."account_state" AS ENUM('active', 'suspended', 'deactivated', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."age_band_if_known" AS ENUM('adult', 'teen_16_17', 'teen_13_15');--> statement-breakpoint
CREATE TYPE "public"."wallet_auth_type" AS ENUM('eoa', 'contract');--> statement-breakpoint
CREATE TYPE "wallet"."unlink_state" AS ENUM('linked', 'unlink_requested', 'unlinked');--> statement-breakpoint
CREATE TYPE "wallet"."wallet_risk_state" AS ENUM('none', 'flagged', 'blocked');--> statement-breakpoint
CREATE TYPE "wallet"."wallet_type" AS ENUM('eoa', 'contract');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"event_type" "audit_event_type" NOT NULL,
	"target_ref" text,
	"context" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state" "deletion_state" DEFAULT 'grace_period' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "export_job_state" DEFAULT 'queued' NOT NULL,
	"progress_pct" integer DEFAULT 0 NOT NULL,
	"download_url_ref" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_ref" "bytea",
	"auth_method" "auth_method" NOT NULL,
	"ip_hash" "bytea" NOT NULL,
	"user_agent_truncated" text,
	"device_label" text,
	"country" text,
	"remember_me" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_auth" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"mfa_totp_secret_encrypted" "bytea",
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_enrolled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"account_state" "account_state" DEFAULT 'active' NOT NULL,
	"locale" text,
	"age_band_if_known" "age_band_if_known",
	"privacy_settings" jsonb NOT NULL,
	"personalization_settings" jsonb NOT NULL,
	"reputation_summary_private" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_handle_pattern" CHECK ("users"."handle" ~ '^[A-Za-z0-9_]{3,30}$')
);
--> statement-breakpoint
CREATE TABLE "wallet_auth_credentials" (
	"credential_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address_hash" "bytea" NOT NULL,
	"address_truncated" text NOT NULL,
	"chain_id" integer NOT NULL,
	"wallet_auth_type" "wallet_auth_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wallet"."wallet_accounts" (
	"wallet_account_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address_hash" "bytea" NOT NULL,
	"address_truncated" text NOT NULL,
	"chain_id" integer NOT NULL,
	"wallet_type" "wallet"."wallet_type" NOT NULL,
	"unlink_state" "wallet"."unlink_state" DEFAULT 'linked' NOT NULL,
	"risk_state" "wallet"."wallet_risk_state" DEFAULT 'none' NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"credential_id" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"device_type" text NOT NULL,
	"device_name" text,
	"transports" text[],
	"backed_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_auth" ADD CONSTRAINT "user_auth_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_auth_credentials" ADD CONSTRAINT "wallet_auth_credentials_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet"."wallet_accounts" ADD CONSTRAINT "wallet_accounts_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "export_jobs_user_idx" ON "export_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "export_jobs_status_idx" ON "export_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mfa_recovery_user_idx" ON "mfa_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_active_idx" ON "sessions" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_handle_lower_idx" ON "users" USING btree (lower("handle"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email")) WHERE "users"."email" is not null;--> statement-breakpoint
CREATE INDEX "users_account_state_idx" ON "users" USING btree ("account_state");--> statement-breakpoint
CREATE INDEX "users_state_created_idx" ON "users" USING btree ("account_state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_auth_addr_idx" ON "wallet_auth_credentials" USING btree ("address_hash");--> statement-breakpoint
CREATE INDEX "wallet_auth_user_idx" ON "wallet_auth_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wallet_accounts_user_idx" ON "wallet"."wallet_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_addr_idx" ON "wallet"."wallet_accounts" USING btree ("address_hash");--> statement-breakpoint
CREATE INDEX "webauthn_cred_user_idx" ON "webauthn_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
	NEW.updated_at = now();
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER user_auth_set_updated_at BEFORE UPDATE ON "user_auth" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
