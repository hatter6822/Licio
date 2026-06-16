-- WS-J Trust, Safety, and Abuse Operations (SPEC §16.4/§18.2/§18.3/§25.4).
-- Hand-authored (the WS-Q migration convention): the auto-generated diff against
-- the stale 0013 snapshot re-emitted WS-Q DDL, so this migration contains ONLY
-- the WS-J additions.  The regenerated 0023 snapshot is a full, accurate
-- baseline that repairs the snapshot drift for future `db:generate`.

CREATE TYPE "public"."report_target_type" AS ENUM('content', 'account', 'room');--> statement-breakpoint
CREATE TYPE "public"."report_content_kind" AS ENUM('story', 'thread', 'contribution');--> statement-breakpoint
CREATE TYPE "public"."report_severity" AS ENUM('minor', 'moderate', 'severe', 'critical');--> statement-breakpoint
CREATE TYPE "public"."report_routed_to" AS ENUM('emergency', 'standard');--> statement-breakpoint
CREATE TYPE "public"."moderation_case_status" AS ENUM('new', 'in_progress', 'resolved', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."appeal_status" AS ENUM('pending', 'overturned', 'upheld', 'modified');--> statement-breakpoint
CREATE TYPE "public"."moderation_notice_kind" AS ENUM('action', 'appeal_outcome');--> statement-breakpoint
CREATE TYPE "public"."reviewer_availability" AS ENUM('available', 'busy', 'offline');--> statement-breakpoint
CREATE TYPE "public"."coordinated_report_incident_status" AS ENUM('open', 'cleared', 'confirmed');--> statement-breakpoint
CREATE TABLE "moderation_cases" (
	"case_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "report_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"content_kind" "report_content_kind",
	"status" "moderation_case_status" DEFAULT 'new' NOT NULL,
	"severity" "report_severity" NOT NULL,
	"routed_to" "report_routed_to" NOT NULL,
	"assigned_to" uuid,
	"report_count" integer DEFAULT 1 NOT NULL,
	"enforcement_delayed" boolean DEFAULT false NOT NULL,
	"resolved_action_id" uuid,
	"sla_due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_reports" (
	"report_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"reporter_user_id" uuid,
	"target_type" "report_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"content_kind" "report_content_kind",
	"reason_code" text NOT NULL,
	"severity" "report_severity" NOT NULL,
	"context" text,
	"evidence_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"local_operation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"action_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"subject_user_id" uuid,
	"reason_code" text,
	"duration" text,
	"reviewer_note" text,
	"prior_state" text,
	"next_state" text,
	"reversible" boolean DEFAULT true NOT NULL,
	"reverted" boolean DEFAULT false NOT NULL,
	"linked_action_id" uuid,
	"case_id" uuid,
	"co_approver_user_id" uuid,
	"report_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_audit" (
	"audit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_time" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text,
	"action" text NOT NULL,
	"reason_code" text,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"subject_user_id" uuid,
	"prior_state" text,
	"next_state" text,
	"reversible" boolean DEFAULT false NOT NULL,
	"linked_action_id" uuid,
	"report_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"co_approver_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_blocks" (
	"block_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_user_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_blocks_not_self" CHECK ("account_blocks"."blocker_user_id" <> "account_blocks"."blocked_user_id")
);
--> statement-breakpoint
CREATE TABLE "account_mutes" (
	"mute_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"muter_user_id" uuid NOT NULL,
	"muted_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_mutes_not_self" CHECK ("account_mutes"."muter_user_id" <> "account_mutes"."muted_user_id")
);
--> statement-breakpoint
CREATE TABLE "moderation_appeals" (
	"appeal_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"appellant_user_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"new_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "appeal_status" DEFAULT 'pending' NOT NULL,
	"assigned_reviewer_id" uuid,
	"is_ban_appeal" boolean DEFAULT false NOT NULL,
	"sla_due_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_reason_code" text,
	"decision_explanation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_notices" (
	"notice_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "moderation_notice_kind" NOT NULL,
	"action_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"reason_code" text,
	"appealable" boolean DEFAULT false NOT NULL,
	"appeal_status" "appeal_status",
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_status" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" "reviewer_availability" DEFAULT 'offline' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coordinated_report_incidents" (
	"incident_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid,
	"target_type" "report_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"report_count" integer NOT NULL,
	"window_seconds" integer NOT NULL,
	"coordination_score" numeric(5, 4) NOT NULL,
	"severity" "report_severity" NOT NULL,
	"status" "coordinated_report_incident_status" DEFAULT 'open' NOT NULL,
	"summary" text NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "steward_roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_case_id_moderation_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("case_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_reporter_user_id_users_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_assigned_to_users_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_user_id_users_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_subject_user_id_users_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_case_id_moderation_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("case_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_co_approver_user_id_users_user_id_fk" FOREIGN KEY ("co_approver_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_audit" ADD CONSTRAINT "moderation_audit_actor_user_id_users_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_audit" ADD CONSTRAINT "moderation_audit_subject_user_id_users_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_audit" ADD CONSTRAINT "moderation_audit_co_approver_user_id_users_user_id_fk" FOREIGN KEY ("co_approver_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_blocks" ADD CONSTRAINT "account_blocks_blocker_user_id_users_user_id_fk" FOREIGN KEY ("blocker_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_blocks" ADD CONSTRAINT "account_blocks_blocked_user_id_users_user_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mutes" ADD CONSTRAINT "account_mutes_muter_user_id_users_user_id_fk" FOREIGN KEY ("muter_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mutes" ADD CONSTRAINT "account_mutes_muted_user_id_users_user_id_fk" FOREIGN KEY ("muted_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_action_id_moderation_actions_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."moderation_actions"("action_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_appellant_user_id_users_user_id_fk" FOREIGN KEY ("appellant_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_assigned_reviewer_id_users_user_id_fk" FOREIGN KEY ("assigned_reviewer_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_decided_by_users_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_notices" ADD CONSTRAINT "moderation_notices_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_status" ADD CONSTRAINT "reviewer_status_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordinated_report_incidents" ADD CONSTRAINT "coordinated_report_incidents_case_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("case_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordinated_report_incidents" ADD CONSTRAINT "coordinated_report_incidents_reviewed_by_users_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_cases_queue_idx" ON "moderation_cases" USING btree ("status","routed_to","severity","sla_due_at");--> statement-breakpoint
CREATE INDEX "moderation_cases_assigned_idx" ON "moderation_cases" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "moderation_cases_target_idx" ON "moderation_cases" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_cases_open_target_uq" ON "moderation_cases" USING btree ("target_type","target_id") WHERE "moderation_cases"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "moderation_reports_case_idx" ON "moderation_reports" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_reports_op_uq" ON "moderation_reports" USING btree ("reporter_user_id","local_operation_id");--> statement-breakpoint
CREATE INDEX "moderation_reports_dedup_idx" ON "moderation_reports" USING btree ("reporter_user_id","target_type","target_id","reason_code");--> statement-breakpoint
CREATE INDEX "moderation_actions_subject_idx" ON "moderation_actions" USING btree ("subject_user_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_actions_target_idx" ON "moderation_actions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_actor_idx" ON "moderation_actions" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "moderation_audit_actor_idx" ON "moderation_audit" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "moderation_audit_subject_idx" ON "moderation_audit" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "moderation_audit_action_idx" ON "moderation_audit" USING btree ("action");--> statement-breakpoint
CREATE INDEX "moderation_audit_reason_idx" ON "moderation_audit" USING btree ("reason_code");--> statement-breakpoint
CREATE INDEX "moderation_audit_time_idx" ON "moderation_audit" USING btree ("event_time");--> statement-breakpoint
CREATE INDEX "moderation_appeals_queue_idx" ON "moderation_appeals" USING btree ("status","sla_due_at");--> statement-breakpoint
CREATE INDEX "moderation_appeals_reviewer_idx" ON "moderation_appeals" USING btree ("assigned_reviewer_id");--> statement-breakpoint
CREATE INDEX "moderation_appeals_appellant_idx" ON "moderation_appeals" USING btree ("appellant_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_appeals_action_uq" ON "moderation_appeals" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "moderation_notices_user_idx" ON "moderation_notices" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_notices_unread_idx" ON "moderation_notices" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "moderation_notices_action_idx" ON "moderation_notices" USING btree ("action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_blocks_pair_uq" ON "account_blocks" USING btree ("blocker_user_id","blocked_user_id");--> statement-breakpoint
CREATE INDEX "account_blocks_blocker_idx" ON "account_blocks" USING btree ("blocker_user_id","created_at");--> statement-breakpoint
CREATE INDEX "account_blocks_blocked_idx" ON "account_blocks" USING btree ("blocked_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_mutes_pair_uq" ON "account_mutes" USING btree ("muter_user_id","muted_user_id");--> statement-breakpoint
CREATE INDEX "account_mutes_muter_idx" ON "account_mutes" USING btree ("muter_user_id","created_at");--> statement-breakpoint
CREATE INDEX "account_mutes_expiry_idx" ON "account_mutes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "coordinated_report_incidents_status_idx" ON "coordinated_report_incidents" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "coordinated_report_incidents_target_idx" ON "coordinated_report_incidents" USING btree ("target_type","target_id");--> statement-breakpoint
-- Append-only enforcement for the moderation audit log (WS-J.2.5a, SPEC §25.4):
-- a BEFORE UPDATE/DELETE row trigger makes the log tamper-evident at the DB
-- level (defense in depth beyond the no-mutate code path).  Two cases:
--   • DELETE is ALWAYS rejected — a record is never erased.
--   • UPDATE is rejected EXCEPT the right-to-erasure (SPEC §19.2 / WS-D account
--     hard-purge) NULLing of the user-reference columns via the `users`
--     ON DELETE SET NULL cascade.  Every substantive field is immutable, and a
--     user reference may only transition TO NULL (never be repointed to another
--     user), so the audit record's content stays tamper-evident while a purged
--     user's identity link is severed (matching the documented purge semantics:
--     "audit rows survive with a severed NULL actor link").
-- TRUNCATE (table-owner only) is intentionally NOT blocked so test fixtures can
-- reset; the application role cannot TRUNCATE in production.
CREATE OR REPLACE FUNCTION "moderation_audit_no_mutate"() RETURNS trigger AS $$
BEGIN
	IF (TG_OP = 'DELETE') THEN
		RAISE EXCEPTION 'moderation_audit is append-only (no DELETE)';
	END IF;
	IF ( NEW."audit_id"         IS DISTINCT FROM OLD."audit_id"
	  OR NEW."event_time"       IS DISTINCT FROM OLD."event_time"
	  OR NEW."actor_role"       IS DISTINCT FROM OLD."actor_role"
	  OR NEW."action"           IS DISTINCT FROM OLD."action"
	  OR NEW."reason_code"      IS DISTINCT FROM OLD."reason_code"
	  OR NEW."target_type"      IS DISTINCT FROM OLD."target_type"
	  OR NEW."target_id"        IS DISTINCT FROM OLD."target_id"
	  OR NEW."prior_state"      IS DISTINCT FROM OLD."prior_state"
	  OR NEW."next_state"       IS DISTINCT FROM OLD."next_state"
	  OR NEW."reversible"       IS DISTINCT FROM OLD."reversible"
	  OR NEW."linked_action_id" IS DISTINCT FROM OLD."linked_action_id"
	  OR NEW."report_ids"       IS DISTINCT FROM OLD."report_ids"
	  OR NEW."notes"            IS DISTINCT FROM OLD."notes"
	  OR NEW."created_at"       IS DISTINCT FROM OLD."created_at"
	  OR (NEW."actor_user_id"       IS DISTINCT FROM OLD."actor_user_id"       AND NEW."actor_user_id"       IS NOT NULL)
	  OR (NEW."subject_user_id"     IS DISTINCT FROM OLD."subject_user_id"     AND NEW."subject_user_id"     IS NOT NULL)
	  OR (NEW."co_approver_user_id" IS DISTINCT FROM OLD."co_approver_user_id" AND NEW."co_approver_user_id" IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'moderation_audit is append-only (only right-to-erasure NULLing of user references is permitted)';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "moderation_audit_append_only" BEFORE UPDATE OR DELETE ON "moderation_audit" FOR EACH ROW EXECUTE FUNCTION "moderation_audit_no_mutate"();
