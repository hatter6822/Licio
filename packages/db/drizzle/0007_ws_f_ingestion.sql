-- WS-F ingestion, source model, and search (hand-tuned around the generated
-- DDL): the pgvector extension must exist BEFORE the `embeddings` table and
-- its HNSW index are created (WS-F.3.2b). Requires a pgvector-enabled
-- PostgreSQL (docker-compose ships pgvector/pgvector:pg16).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."claim_extraction_source" AS ENUM('system', 'user', 'steward');--> statement-breakpoint
CREATE TYPE "public"."claim_record_status" AS ENUM('candidate', 'accepted', 'contested', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."evidence_relationship_type" AS ENUM('supports', 'contradicts', 'contextualizes', 'corrects', 'counterexample');--> statement-breakpoint
CREATE TYPE "public"."evidence_verification_state" AS ENUM('unverified', 'verified', 'disputed', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."embedding_target_type" AS ENUM('story', 'claim', 'source', 'evidence_card', 'community_interpretation');--> statement-breakpoint
CREATE TYPE "public"."ingestion_review_kind" AS ENUM('near_duplicate', 'syndication_candidate', 'extraction_failure', 'url_safety_hold', 'low_confidence_claim');--> statement-breakpoint
CREATE TYPE "public"."ingestion_review_status" AS ENUM('pending', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."syndication_direction" AS ENUM('syndicates_to', 'syndicated_from');--> statement-breakpoint
CREATE TYPE "public"."syndication_established_by" AS ENUM('steward', 'system');--> statement-breakpoint
CREATE TYPE "public"."syndication_relationship_type" AS ENUM('wire', 'republish', 'aggregator', 'partner');--> statement-breakpoint
CREATE TYPE "public"."syndication_status" AS ENUM('candidate', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."story_extraction_state" AS ENUM('pending', 'completed', 'partial', 'failed', 'disallowed_robots', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."story_lifecycle_actor" AS ENUM('system', 'steward');--> statement-breakpoint
CREATE TYPE "public"."story_media_type" AS ENUM('article', 'video', 'podcast', 'dataset', 'report', 'document', 'image');--> statement-breakpoint
CREATE TYPE "public"."story_signature_text_source" AS ENUM('submitted', 'extracted');--> statement-breakpoint
CREATE TYPE "public"."story_hidden_state" AS ENUM('takedown', 'safety');--> statement-breakpoint
CREATE TYPE "public"."story_lifecycle_state" AS ENUM('submitted', 'gathering_attention', 'deepening', 'context_needed', 'bridging', 'stable', 'archived');--> statement-breakpoint
CREATE TYPE "public"."story_lifecycle_trigger" AS ENUM('first_attention', 'sustained_participation', 'scoi_evidence_gap', 'resolved_cleanly', 'lens_reconciliation', 'context_added', 'regressed', 'reconciled', 'renewed_activity', 'low_activity', 'reactivation');--> statement-breakpoint
CREATE TYPE "public"."story_source_link_type" AS ENUM('primary', 'syndicated');--> statement-breakpoint
CREATE TYPE "public"."story_submission_type" AS ENUM('link', 'original_brief', 'question', 'evidence_card', 'local_update', 'live_thread');--> statement-breakpoint
CREATE TYPE "public"."takedown_legal_basis" AS ENUM('copyright', 'privacy', 'court_order', 'other');--> statement-breakpoint
CREATE TYPE "public"."takedown_status" AS ENUM('received', 'under_review', 'actioned', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."takedown_target_type" AS ENUM('story', 'source', 'evidence');--> statement-breakpoint
CREATE TYPE "public"."thread_conversation_state" AS ENUM('empty', 'emerging', 'active', 'deepening', 'resolved', 'dormant');--> statement-breakpoint
CREATE TYPE "public"."thread_safety_state" AS ENUM('normal', 'caution', 'under_review', 'restricted');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'source_profile_edit';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'syndication_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'takedown_action';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'ingestion_review_action';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'ingestion_config_change';--> statement-breakpoint
CREATE TABLE "claims" (
	"claim_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid,
	"canonical_text" text NOT NULL,
	"normalized_text_hash" text NOT NULL,
	"claim_status" "claim_record_status" DEFAULT 'candidate' NOT NULL,
	"first_seen_story_id" uuid,
	"independence_group_id" uuid,
	"created_by" uuid,
	"extraction_source" "claim_extraction_source" NOT NULL,
	"extraction_confidence" double precision,
	"model_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(canonical_text, '')), 'A')) STORED,
	CONSTRAINT "claims_text_len" CHECK (char_length("claims"."canonical_text") between 1 and 1000),
	CONSTRAINT "claims_confidence_range" CHECK ("claims"."extraction_confidence" is null or ("claims"."extraction_confidence" >= 0 and "claims"."extraction_confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "evidence_cards" (
	"evidence_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_id" uuid,
	"submitted_by" uuid NOT NULL,
	"evidence_type" "evidence_relationship_type" NOT NULL,
	"citation_url_or_ref" text NOT NULL,
	"relevance_note" text NOT NULL,
	"verification_state" "evidence_verification_state" DEFAULT 'unverified' NOT NULL,
	"independence_group_id" uuid,
	"story_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(relevance_note, '')), 'A') || setweight(to_tsvector('simple', coalesce(citation_url_or_ref, '')), 'B')) STORED,
	CONSTRAINT "evidence_cards_citation_len" CHECK (char_length("evidence_cards"."citation_url_or_ref") between 1 and 2048),
	CONSTRAINT "evidence_cards_note_len" CHECK (char_length("evidence_cards"."relevance_note") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"embedding_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "embedding_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"model_version" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embeddings_model_version_len" CHECK (char_length("embeddings"."model_version") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "ingestion_review_items" (
	"review_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ingestion_review_kind" NOT NULL,
	"story_id" uuid,
	"context" jsonb NOT NULL,
	"status" "ingestion_review_status" DEFAULT 'pending' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"not_before" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_syndications" (
	"syndication_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_source_id" uuid NOT NULL,
	"to_source_id" uuid NOT NULL,
	"direction" "syndication_direction" DEFAULT 'syndicates_to' NOT NULL,
	"relationship_type" "syndication_relationship_type" NOT NULL,
	"established_by" "syndication_established_by" NOT NULL,
	"status" "syndication_status" NOT NULL,
	"evidence_ref" text NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_syndications_not_self" CHECK ("source_syndications"."from_source_id" <> "source_syndications"."to_source_id"),
	CONSTRAINT "source_syndications_canonical_dir" CHECK ("source_syndications"."direction" = 'syndicates_to'),
	CONSTRAINT "source_syndications_confidence" CHECK ("source_syndications"."confidence" >= 0 and "source_syndications"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"source_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"canonical_domain" text,
	"publisher_lineage" jsonb,
	"typical_topics" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"correction_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_type_frequency" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"community_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"display_restrictions" jsonb DEFAULT '{"noindex": false, "noarchive": false, "excerpt_max_chars": null}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_name_len" CHECK (char_length("sources"."name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"story_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_url" text,
	"title" text NOT NULL,
	"title_hash" text NOT NULL,
	"submitted_by" uuid NOT NULL,
	"source_id" uuid,
	"language" text,
	"topic_ids" uuid[] NOT NULL,
	"location_scope" jsonb,
	"sensitivity_labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"lifecycle_state" "story_lifecycle_state" DEFAULT 'submitted' NOT NULL,
	"submission_type" "story_submission_type" NOT NULL,
	"submission_metadata" jsonb NOT NULL,
	"excerpt" text,
	"publisher" text,
	"author" text,
	"published_at" timestamp with time zone,
	"media_type" "story_media_type",
	"extraction_state" "story_extraction_state" DEFAULT 'pending' NOT NULL,
	"hidden_state" "story_hidden_state",
	"last_material_update_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (
        setweight(to_tsvector(case when language like 'en%' then 'english'::regconfig else 'simple'::regconfig end, coalesce(title, '')), 'A') ||
        setweight(to_tsvector(case when language like 'en%' then 'english'::regconfig else 'simple'::regconfig end, coalesce(excerpt, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(publisher, '') || ' ' || coalesce(author, '')), 'C')
      ) STORED,
	CONSTRAINT "stories_title_len" CHECK (char_length("stories"."title") between 1 and 300),
	CONSTRAINT "stories_topics_nonempty" CHECK (cardinality("stories"."topic_ids") >= 1),
	CONSTRAINT "stories_excerpt_len" CHECK ("stories"."excerpt" is null or char_length("stories"."excerpt") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "story_freshness" (
	"story_id" uuid PRIMARY KEY NOT NULL,
	"freshness_score" double precision NOT NULL,
	"topic_baseline_ms" bigint,
	"feature_version" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "story_freshness_score_range" CHECK ("story_freshness"."freshness_score" >= 0 and "story_freshness"."freshness_score" <= 1)
);
--> statement-breakpoint
CREATE TABLE "story_lifecycle_audits" (
	"audit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"from_state" "story_lifecycle_state" NOT NULL,
	"to_state" "story_lifecycle_state" NOT NULL,
	"trigger" "story_lifecycle_trigger" NOT NULL,
	"actor_type" "story_lifecycle_actor" NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_lsh_bands" (
	"story_id" uuid NOT NULL,
	"band_index" integer NOT NULL,
	"band_hash" bigint NOT NULL,
	CONSTRAINT "story_lsh_bands_story_id_band_index_pk" PRIMARY KEY("story_id","band_index")
);
--> statement-breakpoint
CREATE TABLE "story_signatures" (
	"story_id" uuid PRIMARY KEY NOT NULL,
	"minhash" "bytea" NOT NULL,
	"shingle_k" integer NOT NULL,
	"num_hashes" integer NOT NULL,
	"family_version" integer NOT NULL,
	"text_source" "story_signature_text_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_signatures_minhash_len" CHECK (octet_length("story_signatures"."minhash") = "story_signatures"."num_hashes" * 4)
);
--> statement-breakpoint
CREATE TABLE "story_source_links" (
	"story_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"link_type" "story_source_link_type" NOT NULL,
	"via_canonical_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_source_links_story_id_source_id_pk" PRIMARY KEY("story_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "takedown_requests" (
	"takedown_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "takedown_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"requester_contact" text NOT NULL,
	"legal_basis" "takedown_legal_basis" NOT NULL,
	"claim_detail" text NOT NULL,
	"status" "takedown_status" DEFAULT 'received' NOT NULL,
	"resolution_note" text,
	"actioned_by" uuid,
	"actioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "takedown_requests_detail_len" CHECK (char_length("takedown_requests"."claim_detail") between 10 and 5000)
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"thread_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"room_id" uuid,
	"branch_index" integer DEFAULT 0 NOT NULL,
	"current_summary_id" uuid,
	"conversation_state" "thread_conversation_state" DEFAULT 'empty' NOT NULL,
	"safety_state" "thread_safety_state" DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_first_seen_story_id_stories_story_id_fk" FOREIGN KEY ("first_seen_story_id") REFERENCES "public"."stories"("story_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD CONSTRAINT "evidence_cards_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD CONSTRAINT "evidence_cards_source_id_sources_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("source_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD CONSTRAINT "evidence_cards_submitted_by_users_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_cards" ADD CONSTRAINT "evidence_cards_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_review_items" ADD CONSTRAINT "ingestion_review_items_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_review_items" ADD CONSTRAINT "ingestion_review_items_resolved_by_users_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_syndications" ADD CONSTRAINT "source_syndications_from_source_id_sources_source_id_fk" FOREIGN KEY ("from_source_id") REFERENCES "public"."sources"("source_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_syndications" ADD CONSTRAINT "source_syndications_to_source_id_sources_source_id_fk" FOREIGN KEY ("to_source_id") REFERENCES "public"."sources"("source_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_submitted_by_users_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_source_id_sources_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("source_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_freshness" ADD CONSTRAINT "story_freshness_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_lifecycle_audits" ADD CONSTRAINT "story_lifecycle_audits_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_lifecycle_audits" ADD CONSTRAINT "story_lifecycle_audits_actor_user_id_users_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_lsh_bands" ADD CONSTRAINT "story_lsh_bands_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_signatures" ADD CONSTRAINT "story_signatures_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_source_links" ADD CONSTRAINT "story_source_links_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_source_links" ADD CONSTRAINT "story_source_links_source_id_sources_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("source_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takedown_requests" ADD CONSTRAINT "takedown_requests_actioned_by_users_user_id_fk" FOREIGN KEY ("actioned_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claims_story_idx" ON "claims" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "claims_status_idx" ON "claims" USING btree ("claim_status");--> statement-breakpoint
CREATE INDEX "claims_independence_idx" ON "claims" USING btree ("independence_group_id");--> statement-breakpoint
CREATE INDEX "claims_text_hash_idx" ON "claims" USING btree ("normalized_text_hash");--> statement-breakpoint
CREATE INDEX "claims_search_gin" ON "claims" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "evidence_cards_claim_idx" ON "evidence_cards" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "evidence_cards_source_idx" ON "evidence_cards" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "evidence_cards_independence_idx" ON "evidence_cards" USING btree ("independence_group_id");--> statement-breakpoint
CREATE INDEX "evidence_cards_search_gin" ON "evidence_cards" USING gin ("search_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_target_model_uq" ON "embeddings" USING btree ("target_type","target_id","model_version");--> statement-breakpoint
CREATE INDEX "embeddings_hnsw_cosine_idx" ON "embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "embeddings_type_version_idx" ON "embeddings" USING btree ("target_type","model_version");--> statement-breakpoint
CREATE INDEX "ingestion_review_status_idx" ON "ingestion_review_items" USING btree ("status","kind","created_at");--> statement-breakpoint
CREATE INDEX "ingestion_review_story_idx" ON "ingestion_review_items" USING btree ("story_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_syndications_pair_uq" ON "source_syndications" USING btree ("from_source_id","to_source_id");--> statement-breakpoint
CREATE INDEX "source_syndications_to_idx" ON "source_syndications" USING btree ("to_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_domain_lower_idx" ON "sources" USING btree (lower("canonical_domain")) WHERE "sources"."canonical_domain" is not null;--> statement-breakpoint
CREATE INDEX "sources_topics_gin" ON "sources" USING gin ("typical_topics");--> statement-breakpoint
CREATE UNIQUE INDEX "stories_canonical_url_uq" ON "stories" USING btree ("canonical_url") WHERE "stories"."canonical_url" is not null;--> statement-breakpoint
CREATE INDEX "stories_source_idx" ON "stories" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "stories_topic_gin" ON "stories" USING gin ("topic_ids");--> statement-breakpoint
CREATE INDEX "stories_lifecycle_idx" ON "stories" USING btree ("lifecycle_state","updated_at");--> statement-breakpoint
CREATE INDEX "stories_title_hash_idx" ON "stories" USING btree ("title_hash","created_at");--> statement-breakpoint
CREATE INDEX "stories_created_idx" ON "stories" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "stories_search_gin" ON "stories" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "story_lifecycle_audits_story_idx" ON "story_lifecycle_audits" USING btree ("story_id","created_at");--> statement-breakpoint
CREATE INDEX "story_lsh_bands_lookup_idx" ON "story_lsh_bands" USING btree ("band_index","band_hash");--> statement-breakpoint
CREATE INDEX "story_source_links_source_idx" ON "story_source_links" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "takedown_requests_status_idx" ON "takedown_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "takedown_requests_target_idx" ON "takedown_requests" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_story_uq" ON "threads" USING btree ("story_id");--> statement-breakpoint
-- updated_at auto-maintenance (house pattern from 0000: Drizzle emits no
-- on-update clause for pg timestamps; the trigger keeps the column honest).
CREATE TRIGGER stories_set_updated_at BEFORE UPDATE ON "stories" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER sources_set_updated_at BEFORE UPDATE ON "sources" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER claims_set_updated_at BEFORE UPDATE ON "claims" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER embeddings_set_updated_at BEFORE UPDATE ON "embeddings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
