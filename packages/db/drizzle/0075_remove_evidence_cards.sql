-- Remove the EvidenceCard entity (comment-centric sourcing).
--
-- No production path ever created or verified an evidence card (creation was
-- API-only with no client; verification had no writer at all), so the entity
-- and its enums are removed outright.  Sourcing is comment-centric: a comment
-- carries its sources as citations.  Rows referencing the retired values are
-- MAPPED, never silently lost, wherever they carry user/legal/audit meaning:
-- an `evidence` contribution becomes a sourced comment, an evidence-target
-- takedown remaps to the card's story, and the append-only LCAP publish audit
-- is rewritten losslessly (the original coordinate is preserved in
-- `target_id`).  Only derived linkage rows (provenance / review state) and
-- retired-topic event rows are deleted.

-- ---------------------------------------------------------------------------
-- 1. Takedowns FIRST (they join through evidence_cards, which drops below).
--    Legal/moderation records are preserved: each evidence-target request
--    remaps to the card's story when resolvable (the card's own story, else
--    its claim's story) and keeps its original id otherwise; every remapped
--    row records the original coordinate on its resolution note.
-- ---------------------------------------------------------------------------
UPDATE "takedown_requests" tr SET
    "target_id" = COALESCE(sub."mapped", tr."target_id"),
    "resolution_note" = concat_ws(E'\n', tr."resolution_note",
      concat('[migration 0075] originally target_type=evidence target_id=', tr."target_id"::text))
  FROM (
    SELECT tr2."takedown_id" AS tid, COALESCE(ec."story_id", c."story_id") AS "mapped"
    FROM "takedown_requests" tr2
    LEFT JOIN "evidence_cards" ec ON ec."evidence_id" = tr2."target_id"
    LEFT JOIN "claims" c ON c."claim_id" = ec."claim_id"
    WHERE tr2."target_type" = 'evidence'
  ) sub
  WHERE tr."takedown_id" = sub.tid;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. LCAP tables that reuse the takedown enum.  Provenance and review rows
--    are derived linkage state for an entity that no longer exists ⇒ deleted.
--    The publish AUDIT is append-only (the `lcap_publish_audit_append_only`
--    trigger raises on UPDATE/DELETE), so it is rewritten LOSSLESSLY with the
--    trigger temporarily disabled: `target_type` goes NULL (the column is
--    nullable by design) and the original coordinate is preserved inside
--    `target_id` — no audit row is removed or truncated.
-- ---------------------------------------------------------------------------
DELETE FROM "lcap_block_provenance" WHERE "target_type" = 'evidence';--> statement-breakpoint
DELETE FROM "lcap_block_publish_review" WHERE "target_type" = 'evidence';--> statement-breakpoint
ALTER TABLE "lcap_publish_audit" DISABLE TRIGGER "lcap_publish_audit_append_only";--> statement-breakpoint
UPDATE "lcap_publish_audit"
  SET "target_id" = concat('evidence:', "target_id"), "target_type" = NULL
  WHERE "target_type" = 'evidence';--> statement-breakpoint
ALTER TABLE "lcap_publish_audit" ENABLE TRIGGER "lcap_publish_audit_append_only";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Recreate takedown_target_type without 'evidence' (every column of the
--    old type migrates; ALTER COLUMN TYPE rewrites rows without firing the
--    row-level audit trigger).  Any takedown row still carrying 'evidence'
--    (already remapped + annotated above) lands on 'story'.
-- ---------------------------------------------------------------------------
ALTER TYPE "takedown_target_type" RENAME TO "takedown_target_type_old";--> statement-breakpoint
CREATE TYPE "takedown_target_type" AS ENUM('story', 'source');--> statement-breakpoint
ALTER TABLE "takedown_requests" ALTER COLUMN "target_type" TYPE "takedown_target_type"
  USING (case when "target_type"::text = 'evidence' then 'story' else "target_type"::text end)::"takedown_target_type";--> statement-breakpoint
ALTER TABLE "lcap_block_provenance" ALTER COLUMN "target_type" TYPE "takedown_target_type"
  USING "target_type"::text::"takedown_target_type";--> statement-breakpoint
ALTER TABLE "lcap_block_publish_review" ALTER COLUMN "target_type" TYPE "takedown_target_type"
  USING "target_type"::text::"takedown_target_type";--> statement-breakpoint
ALTER TABLE "lcap_publish_audit" ALTER COLUMN "target_type" TYPE "takedown_target_type"
  USING "target_type"::text::"takedown_target_type";--> statement-breakpoint
DROP TYPE "takedown_target_type_old";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Drop the entity and its own enums.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "evidence_cards";--> statement-breakpoint
DROP TYPE IF EXISTS "evidence_card_type";--> statement-breakpoint
DROP TYPE IF EXISTS "evidence_relationship_type";--> statement-breakpoint
DROP TYPE IF EXISTS "evidence_verification_state";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. contributions.type: retire 'evidence' (an evidence contribution is a
--    sourced comment in the new model; children keep a valid parent).  The
--    retired per-type metadata keys are stripped so the strict egress schema
--    keeps parsing migrated rows.
-- ---------------------------------------------------------------------------
UPDATE "contributions" SET "metadata" = ("metadata" - 'evidence_type') - 'evidence_id'
  WHERE "metadata" ?| array['evidence_type', 'evidence_id'];--> statement-breakpoint
ALTER TYPE "contribution_type" RENAME TO "contribution_type_old";--> statement-breakpoint
CREATE TYPE "contribution_type" AS ENUM('question', 'answer', 'correction', 'synthesis', 'counterexample', 'explanation', 'local_context', 'direct_experience', 'moderation_concern', 'meta_discussion', 'comment');--> statement-breakpoint
ALTER TABLE "contributions" ALTER COLUMN "type" TYPE "contribution_type"
  USING (case when "type"::text = 'evidence' then 'comment' else "type"::text end)::"contribution_type";--> statement-breakpoint
DROP TYPE "contribution_type_old";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. stories.submission_type: retire 'evidence_card' (map the shell to the
--    closest surviving type).  The JSONB metadata is rewritten IN STEP with
--    the column so the surviving strict schema keeps parsing the row and
--    `submissionBodyText()` (which switches on the metadata's own type) keeps
--    returning the note text.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 7. embeddings.target_type: retire 'evidence_card' (card vectors go with the
--    cards).
-- ---------------------------------------------------------------------------
DELETE FROM "embeddings" WHERE "target_type" = 'evidence_card';--> statement-breakpoint
ALTER TYPE "embedding_target_type" RENAME TO "embedding_target_type_old";--> statement-breakpoint
CREATE TYPE "embedding_target_type" AS ENUM('story', 'claim', 'source', 'community_interpretation');--> statement-breakpoint
ALTER TABLE "embeddings" ALTER COLUMN "target_type" TYPE "embedding_target_type"
  USING "target_type"::text::"embedding_target_type";--> statement-breakpoint
DROP TYPE "embedding_target_type_old";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Durable event log: legacy rows carrying the retired shapes must keep
--    replaying (checkpoint recovery / DLQ redrive only replays rows that
--    parse).  content.submitted / content.normalized payloads remap in step
--    with the stories column above; a legacy `evidence` contribution.created
--    remaps to `explanation` — exactly how a sourced comment scores today
--    (its `has_citation` flag keeps carrying the citation weight); rows of
--    the retired evidence.added topic are dropped with their topic.
-- ---------------------------------------------------------------------------
UPDATE "events" SET "payload" = jsonb_set("payload", '{submission_type}', '"original_brief"')
  WHERE "topic" IN ('content.submitted', 'content.normalized')
    AND "payload"->>'submission_type' = 'evidence_card';--> statement-breakpoint
UPDATE "events" SET "payload" = jsonb_set("payload", '{contribution_type}', '"explanation"')
  WHERE "topic" = 'contribution.created'
    AND "payload"->>'contribution_type' = 'evidence';--> statement-breakpoint
DELETE FROM "events" WHERE "topic" = 'evidence.added';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. room_subscriptions: strip the retired `new_evidence` notification key so
--    the strict preferences schema keeps parsing stored blobs.
-- ---------------------------------------------------------------------------
UPDATE "room_subscriptions"
  SET "notification_preferences" = "notification_preferences" - 'new_evidence'
  WHERE "notification_preferences" ? 'new_evidence';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. sources: the evidence-type frequency aggregate had no surviving writer.
-- ---------------------------------------------------------------------------
ALTER TABLE "sources" DROP COLUMN IF EXISTS "evidence_type_frequency";
