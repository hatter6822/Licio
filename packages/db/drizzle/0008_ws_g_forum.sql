-- WS-G forum, conversation, rooms, and lenses (hand-tuned around the
-- generated DDL).  Three structural moves need custom SQL:
--   1. The thread shell vocabularies are REPLACED (not extended) via enum
--      recreation with a USING map, so the final enums hold exactly the
--      WS-G.1.1 canon (empty|emerging→active, dormant→archived,
--      caution→elevated) and legacy values cannot be written again.
--   2. evidence_cards gains the MATERIAL `evidence_type` dimension; the
--      WS-F-era column (which held the RELATIONSHIP taxonomy) is renamed to
--      `relationship_type`.  Existing rows backfill to 'report' (the least
--      wrong generic for pre-WS-G cards, which carried no material type).
--   3. Two deliberate SQL-level FKs avoid TS module cycles:
--      threads.current_summary_id → summaries and
--      evidence_cards.contribution_id → contributions.
CREATE TYPE "public"."contribution_type" AS ENUM('question', 'answer', 'evidence', 'correction', 'synthesis', 'counterexample', 'explanation', 'local_context', 'direct_experience', 'moderation_concern', 'meta_discussion');--> statement-breakpoint
CREATE TYPE "public"."contribution_moderation_state" AS ENUM('published', 'under_review', 'hidden', 'removed');--> statement-breakpoint
CREATE TYPE "public"."room_type" AS ENUM('global_topic', 'local_geographic', 'professional_domain', 'event', 'learning', 'steward');--> statement-breakpoint
CREATE TYPE "public"."room_visibility" AS ENUM('public', 'restricted', 'expert_led');--> statement-breakpoint
CREATE TYPE "public"."governance_mode" AS ENUM('ordinary', 'simulated', 'testnet', 'capped_production', 'mature_production', 'frozen', 'migrating');--> statement-breakpoint
CREATE TYPE "public"."room_steward_role" AS ENUM('community_steward', 'evidence_steward', 'safety_moderator', 'appeals_reviewer', 'integrity_analyst');--> statement-breakpoint
CREATE TYPE "public"."lens_type" AS ENUM('local_resident', 'beginner', 'expert', 'affected_community', 'skeptical', 'policy', 'historical');--> statement-breakpoint
CREATE TYPE "public"."room_subscription_status" AS ENUM('active', 'pending');--> statement-breakpoint
CREATE TYPE "public"."summary_layer" AS ENUM('automated_draft', 'community_synthesis', 'steward_summary');--> statement-breakpoint
CREATE TYPE "public"."evidence_card_type" AS ENUM('primary_source', 'dataset', 'transcript', 'legal_text', 'report', 'expert_reference', 'fact_check');--> statement-breakpoint
CREATE TYPE "public"."upload_scan_state" AS ENUM('pending', 'clear', 'flagged');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'thread_state_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'contribution_moderation_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'evidence_verification_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'summary_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'room_steward_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'forum_config_change';--> statement-breakpoint
ALTER TYPE "public"."ingestion_review_kind" ADD VALUE 'contribution_safety_hold';--> statement-breakpoint
ALTER TYPE "public"."ingestion_review_kind" ADD VALUE 'moderation_concern';--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "conversation_state" DROP DEFAULT;--> statement-breakpoint
CREATE TYPE "public"."thread_conversation_state_v2" AS ENUM('active', 'deepening', 'tense', 'under_review', 'resolved', 'archived');--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "conversation_state" TYPE "public"."thread_conversation_state_v2" USING (CASE "conversation_state"::text WHEN 'empty' THEN 'active' WHEN 'emerging' THEN 'active' WHEN 'dormant' THEN 'archived' ELSE "conversation_state"::text END)::"public"."thread_conversation_state_v2";--> statement-breakpoint
DROP TYPE "public"."thread_conversation_state";--> statement-breakpoint
ALTER TYPE "public"."thread_conversation_state_v2" RENAME TO "thread_conversation_state";--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "conversation_state" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "safety_state" DROP DEFAULT;--> statement-breakpoint
CREATE TYPE "public"."thread_safety_state_v2" AS ENUM('normal', 'elevated', 'under_review', 'restricted');--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "safety_state" TYPE "public"."thread_safety_state_v2" USING (CASE "safety_state"::text WHEN 'caution' THEN 'elevated' ELSE "safety_state"::text END)::"public"."thread_safety_state_v2";--> statement-breakpoint
DROP TYPE "public"."thread_safety_state";--> statement-breakpoint
ALTER TYPE "public"."thread_safety_state_v2" RENAME TO "thread_safety_state";--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "safety_state" SET DEFAULT 'normal';--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "threads_story_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "threads_story_branch_uq" ON "threads" USING btree ("story_id","branch_index");--> statement-breakpoint
CREATE INDEX "threads_story_idx" ON "threads" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "threads_room_idx" ON "threads" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "threads_conversation_idx" ON "threads" USING btree ("conversation_state");--> statement-breakpoint
CREATE INDEX "threads_safety_idx" ON "threads" USING btree ("safety_state");--> statement-breakpoint
CREATE INDEX "threads_created_idx" ON "threads" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_story_id_stories_story_id_fk";--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "rooms" (
	"room_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"room_type" "room_type" NOT NULL,
	"visibility" "room_visibility" DEFAULT 'public' NOT NULL,
	"created_by" uuid,
	"governance_mode" "governance_mode" DEFAULT 'ordinary' NOT NULL,
	"charter_summary" text,
	"type_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latest_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_name_len" CHECK (char_length("rooms"."name") between 1 and 100),
	CONSTRAINT "rooms_slug_len" CHECK (char_length("rooms"."slug") between 1 and 120),
	CONSTRAINT "rooms_description_len" CHECK ("rooms"."description" is null or char_length("rooms"."description") <= 2000),
	CONSTRAINT "rooms_charter_len" CHECK ("rooms"."charter_summary" is null or char_length("rooms"."charter_summary") <= 5000)
);--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_type_slug_uq" ON "rooms" USING btree ("room_type","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_type_name_uq" ON "rooms" USING btree ("room_type",lower("name"));--> statement-breakpoint
CREATE INDEX "rooms_type_idx" ON "rooms" USING btree ("room_type");--> statement-breakpoint
CREATE INDEX "rooms_visibility_idx" ON "rooms" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "rooms_governance_idx" ON "rooms" USING btree ("governance_mode");--> statement-breakpoint
CREATE INDEX "rooms_created_idx" ON "rooms" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "rooms_activity_idx" ON "rooms" USING btree ("latest_activity_at");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "room_stewards" (
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "room_steward_role" NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_stewards_room_id_user_id_role_pk" PRIMARY KEY("room_id","user_id","role")
);--> statement-breakpoint
ALTER TABLE "room_stewards" ADD CONSTRAINT "room_stewards_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_stewards" ADD CONSTRAINT "room_stewards_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_stewards_user_idx" ON "room_stewards" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE "room_subscriptions" (
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "room_subscription_status" NOT NULL,
	"request_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"notification_preferences" jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone,
	CONSTRAINT "room_subscriptions_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);--> statement-breakpoint
ALTER TABLE "room_subscriptions" ADD CONSTRAINT "room_subscriptions_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_subscriptions" ADD CONSTRAINT "room_subscriptions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_subscriptions_request_uq" ON "room_subscriptions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "room_subscriptions_user_idx" ON "room_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "room_subscriptions_room_status_idx" ON "room_subscriptions" USING btree ("room_id","status");--> statement-breakpoint
CREATE TABLE "lenses" (
	"lens_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lens_type" "lens_type" NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lenses_name_len" CHECK (char_length("lenses"."name") between 1 and 100),
	CONSTRAINT "lenses_description_len" CHECK ("lenses"."description" is null or char_length("lenses"."description") <= 1000)
);--> statement-breakpoint
ALTER TABLE "lenses" ADD CONSTRAINT "lenses_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lenses_room_type_uq" ON "lenses" USING btree ("room_id","lens_type");--> statement-breakpoint
CREATE TABLE "summaries" (
	"summary_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"layer" "summary_layer" NOT NULL,
	"body" text NOT NULL,
	"cited_branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cited_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unresolved_uncertainty" text,
	"minority_views_note" text,
	"authored_by" uuid,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summaries_body_len" CHECK (char_length("summaries"."body") between 1 and 10000),
	CONSTRAINT "summaries_uncertainty_required" CHECK ("summaries"."layer" = 'automated_draft' or ("summaries"."unresolved_uncertainty" is not null and char_length("summaries"."unresolved_uncertainty") >= 1)),
	CONSTRAINT "summaries_branch_ids_array" CHECK (jsonb_typeof("summaries"."cited_branch_ids") = 'array'),
	CONSTRAINT "summaries_evidence_ids_array" CHECK (jsonb_typeof("summaries"."cited_evidence_ids") = 'array')
);--> statement-breakpoint
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_thread_id_threads_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_authored_by_users_user_id_fk" FOREIGN KEY ("authored_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_approved_by_users_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "summaries_thread_layer_idx" ON "summaries" USING btree ("thread_id","layer");--> statement-breakpoint
CREATE INDEX "summaries_created_idx" ON "summaries" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_current_summary_id_summaries_summary_id_fk" FOREIGN KEY ("current_summary_id") REFERENCES "public"."summaries"("summary_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "contributions" (
	"contribution_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid,
	"type" "contribution_type" NOT NULL,
	"body" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_claim_id" uuid,
	"parent_contribution_id" uuid,
	"client_draft_id" text NOT NULL,
	"path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edit_history_ref" uuid,
	"moderation_state" "contribution_moderation_state" DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contributions_body_len" CHECK (char_length("contributions"."body") between 1 and 5000),
	CONSTRAINT "contributions_citations_array" CHECK (jsonb_typeof("contributions"."citations") = 'array'),
	CONSTRAINT "contributions_metadata_object" CHECK (jsonb_typeof("contributions"."metadata") = 'object'),
	CONSTRAINT "contributions_path_array" CHECK (jsonb_typeof("contributions"."path") = 'array'),
	CONSTRAINT "contributions_depth_cap" CHECK (jsonb_array_length("contributions"."path") between 0 and 10),
	CONSTRAINT "contributions_path_parent_consistent" CHECK (("contributions"."parent_contribution_id" is null) = (jsonb_array_length("contributions"."path") = 0))
);--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_thread_id_threads_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_target_claim_id_claims_claim_id_fk" FOREIGN KEY ("target_claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_parent_fk" FOREIGN KEY ("parent_contribution_id") REFERENCES "public"."contributions"("contribution_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contributions_thread_idx" ON "contributions" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "contributions_user_idx" ON "contributions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contributions_parent_idx" ON "contributions" USING btree ("parent_contribution_id");--> statement-breakpoint
CREATE INDEX "contributions_type_idx" ON "contributions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "contributions_moderation_idx" ON "contributions" USING btree ("moderation_state");--> statement-breakpoint
CREATE INDEX "contributions_created_idx" ON "contributions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "contributions_thread_type_created_idx" ON "contributions" USING btree ("thread_id","type","created_at");--> statement-breakpoint
CREATE INDEX "contributions_citations_gin" ON "contributions" USING gin ("citations");--> statement-breakpoint
CREATE INDEX "contributions_metadata_gin" ON "contributions" USING gin ("metadata");--> statement-breakpoint
CREATE INDEX "contributions_path_gin" ON "contributions" USING gin ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "contributions_user_draft_uq" ON "contributions" USING btree ("user_id","client_draft_id") WHERE "contributions"."user_id" is not null;--> statement-breakpoint
CREATE TABLE "contribution_edit_history" (
	"edit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contribution_id" uuid NOT NULL,
	"edited_by" uuid,
	"previous_body" text NOT NULL,
	"previous_citations" jsonb NOT NULL,
	"previous_metadata" jsonb NOT NULL,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "contribution_edit_history" ADD CONSTRAINT "contribution_edit_history_contribution_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contributions"("contribution_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_edit_history" ADD CONSTRAINT "contribution_edit_history_edited_by_users_user_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contribution_edit_history_contribution_idx" ON "contribution_edit_history" USING btree ("contribution_id","edited_at");--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_edit_history_ref_fk" FOREIGN KEY ("edit_history_ref") REFERENCES "public"."contribution_edit_history"("edit_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_cards" RENAME COLUMN "evidence_type" TO "relationship_type";--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD COLUMN "evidence_type" "evidence_card_type" DEFAULT 'report' NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_cards" ALTER COLUMN "evidence_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD COLUMN "contribution_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_cards" ALTER COLUMN "submitted_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_cards" DROP CONSTRAINT "evidence_cards_submitted_by_users_user_id_fk";--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD CONSTRAINT "evidence_cards_submitted_by_users_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_cards" DROP CONSTRAINT "evidence_cards_claim_id_claims_claim_id_fk";--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD CONSTRAINT "evidence_cards_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_cards" DROP CONSTRAINT "evidence_cards_source_id_sources_source_id_fk";--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD CONSTRAINT "evidence_cards_source_id_sources_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("source_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD CONSTRAINT "evidence_cards_contribution_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contributions"("contribution_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_cards_contribution_idx" ON "evidence_cards" USING btree ("contribution_id");--> statement-breakpoint
CREATE INDEX "evidence_cards_submitted_by_idx" ON "evidence_cards" USING btree ("submitted_by");--> statement-breakpoint
CREATE INDEX "evidence_cards_type_idx" ON "evidence_cards" USING btree ("evidence_type");--> statement-breakpoint
CREATE INDEX "evidence_cards_verification_idx" ON "evidence_cards" USING btree ("verification_state");--> statement-breakpoint
CREATE TABLE "uploads" (
	"upload_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"alt_text" text,
	"storage_ref" text NOT NULL,
	"metadata_stripped" boolean NOT NULL,
	"scan_state" "upload_scan_state" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_content_type_allowed" CHECK ("uploads"."content_type" in ('image/jpeg','image/png','image/webp','image/avif','application/pdf')),
	CONSTRAINT "uploads_byte_size_range" CHECK ("uploads"."byte_size" between 1 and 10485760),
	CONSTRAINT "uploads_alt_len" CHECK ("uploads"."alt_text" is null or char_length("uploads"."alt_text") between 1 and 500)
);--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_owner_user_id_users_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "uploads_owner_idx" ON "uploads" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "uploads_scan_idx" ON "uploads" USING btree ("scan_state");
