-- Remove the EvidenceCard entity (comment-centric sourcing).
--
-- No production path ever created or verified an evidence card (creation was
-- API-only with no client; verification had no writer at all), so the entity
-- and its enums are removed outright.  Sourcing is comment-centric: a comment
-- carries its sources as citations.  Stray dev rows using the retired values
-- are MAPPED, not deleted, where they may have dependents (an `evidence`
-- contribution becomes a sourced comment — it already carries citations), and
-- deleted where they cannot (takedowns, embeddings).

DROP TABLE IF EXISTS "evidence_cards";--> statement-breakpoint
DROP TYPE IF EXISTS "evidence_card_type";--> statement-breakpoint
DROP TYPE IF EXISTS "evidence_relationship_type";--> statement-breakpoint
DROP TYPE IF EXISTS "evidence_verification_state";--> statement-breakpoint

-- contributions.type: retire 'evidence' (an evidence contribution is a
-- sourced comment in the new model; children keep a valid parent).  The
-- retired per-type metadata keys are stripped so the strict egress schema
-- keeps parsing migrated rows.
UPDATE "contributions" SET "metadata" = ("metadata" - 'evidence_type') - 'evidence_id'
  WHERE "metadata" ?| array['evidence_type', 'evidence_id'];--> statement-breakpoint
ALTER TYPE "contribution_type" RENAME TO "contribution_type_old";--> statement-breakpoint
CREATE TYPE "contribution_type" AS ENUM('question', 'answer', 'correction', 'synthesis', 'counterexample', 'explanation', 'local_context', 'direct_experience', 'moderation_concern', 'meta_discussion', 'comment');--> statement-breakpoint
ALTER TABLE "contributions" ALTER COLUMN "type" TYPE "contribution_type"
  USING (case when "type"::text = 'evidence' then 'comment' else "type"::text end)::"contribution_type";--> statement-breakpoint
DROP TYPE "contribution_type_old";--> statement-breakpoint

-- stories.submission_type: retire 'evidence_card' (map the shell to the
-- closest surviving type).  The JSONB metadata is rewritten IN STEP with the
-- column so the surviving strict schema keeps parsing the row and
-- `submissionBodyText()` (which switches on the metadata's own type) keeps
-- returning the note text.
UPDATE "stories" SET "submission_metadata" = jsonb_build_object(
    'submission_type', 'original_brief',
    'body', concat_ws(E'\n\n',
      nullif("submission_metadata"->>'relevance_note', ''),
      nullif("submission_metadata"->>'citation_url_or_ref', '')))
  WHERE "submission_metadata"->>'submission_type' = 'evidence_card';--> statement-breakpoint
ALTER TYPE "story_submission_type" RENAME TO "story_submission_type_old";--> statement-breakpoint
CREATE TYPE "story_submission_type" AS ENUM('link', 'original_brief', 'question', 'local_update', 'live_thread', 'image_post', 'video_post');--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "submission_type" TYPE "story_submission_type"
  USING (case when "submission_type"::text = 'evidence_card' then 'original_brief' else "submission_type"::text end)::"story_submission_type";--> statement-breakpoint
DROP TYPE "story_submission_type_old";--> statement-breakpoint

-- Durable event log: legacy rows carrying the retired shapes must keep
-- replaying (checkpoint recovery / DLQ redrive only replays rows that parse).
-- content.submitted / content.normalized payloads are remapped in step with
-- the stories column above; evidence.added rows are dropped with their topic.
UPDATE "events" SET "payload" = jsonb_set("payload", '{submission_type}', '"original_brief"')
  WHERE "topic" IN ('content.submitted', 'content.normalized')
    AND "payload"->>'submission_type' = 'evidence_card';--> statement-breakpoint
DELETE FROM "events" WHERE "topic" = 'evidence.added';--> statement-breakpoint

-- takedown_requests.target_type (+ the three WS-R LCAP tables that reuse the
-- enum): retire 'evidence' (a takedown / provenance link against a dropped
-- card has no target; such rows are dev-only).  EVERY column of the old type
-- must be migrated before the type can drop.
DELETE FROM "takedown_requests" WHERE "target_type" = 'evidence';--> statement-breakpoint
DELETE FROM "lcap_block_provenance" WHERE "target_type" = 'evidence';--> statement-breakpoint
DELETE FROM "lcap_block_publish_review" WHERE "target_type" = 'evidence';--> statement-breakpoint
DELETE FROM "lcap_publish_audit" WHERE "target_type" = 'evidence';--> statement-breakpoint
ALTER TYPE "takedown_target_type" RENAME TO "takedown_target_type_old";--> statement-breakpoint
CREATE TYPE "takedown_target_type" AS ENUM('story', 'source');--> statement-breakpoint
ALTER TABLE "takedown_requests" ALTER COLUMN "target_type" TYPE "takedown_target_type"
  USING "target_type"::text::"takedown_target_type";--> statement-breakpoint
ALTER TABLE "lcap_block_provenance" ALTER COLUMN "target_type" TYPE "takedown_target_type"
  USING "target_type"::text::"takedown_target_type";--> statement-breakpoint
ALTER TABLE "lcap_block_publish_review" ALTER COLUMN "target_type" TYPE "takedown_target_type"
  USING "target_type"::text::"takedown_target_type";--> statement-breakpoint
ALTER TABLE "lcap_publish_audit" ALTER COLUMN "target_type" TYPE "takedown_target_type"
  USING "target_type"::text::"takedown_target_type";--> statement-breakpoint
DROP TYPE "takedown_target_type_old";--> statement-breakpoint

-- embeddings.target_type: retire 'evidence_card' (card vectors go with the
-- cards).
DELETE FROM "embeddings" WHERE "target_type" = 'evidence_card';--> statement-breakpoint
ALTER TYPE "embedding_target_type" RENAME TO "embedding_target_type_old";--> statement-breakpoint
CREATE TYPE "embedding_target_type" AS ENUM('story', 'claim', 'source', 'community_interpretation');--> statement-breakpoint
ALTER TABLE "embeddings" ALTER COLUMN "target_type" TYPE "embedding_target_type"
  USING "target_type"::text::"embedding_target_type";--> statement-breakpoint
DROP TYPE "embedding_target_type_old";--> statement-breakpoint

-- room_subscriptions: strip the retired `new_evidence` notification key so the
-- strict preferences schema keeps parsing stored blobs.
UPDATE "room_subscriptions"
  SET "notification_preferences" = "notification_preferences" - 'new_evidence'
  WHERE "notification_preferences" ? 'new_evidence';--> statement-breakpoint

-- sources: the evidence-type frequency aggregate had no surviving writer.
ALTER TABLE "sources" DROP COLUMN IF EXISTS "evidence_type_frequency";
