-- Retire the WS-G-era write taxonomy and the never-fed placeholder columns.
--
-- The client sends exactly two contribution types (`comment`, `correction`)
-- and four submission types (`link`, `original_brief`, `image_post`,
-- `video_post`); every other value was producible only through the dev
-- simulator / demo seed (SPEC §15.1 retired them from writes; SPEC §14.1
-- lists only the four).  Stray dev rows are MAPPED onto the survivors (their
-- bodies and citations are preserved), the durable event log is remapped in
-- step so checkpoint replay keeps parsing, and the placeholder columns that
-- never had a writer (private reputation summary, room notification
-- preferences) are dropped.

-- ---------------------------------------------------------------------------
-- 1. contributions: strip retired per-type metadata keys, then map the nine
--    legacy types onto `comment` (bodies + citations survive; a legacy
--    question/answer/synthesis reads as an ordinary comment).
-- ---------------------------------------------------------------------------
UPDATE "contributions" SET "metadata" = "metadata"
    - 'included_branch_ids' - 'uncertainty_note' - 'relevance_explanation'
    - 'source_url' - 'assumptions' - 'caveats' - 'scope' - 'location'
    - 'time_context' - 'privacy_acknowledged' - 'reason_code' - 'urgency'
  WHERE "metadata" ?| array['included_branch_ids','uncertainty_note','relevance_explanation','source_url','assumptions','caveats','scope','location','time_context','privacy_acknowledged','reason_code','urgency'];--> statement-breakpoint
ALTER TYPE "contribution_type" RENAME TO "contribution_type_old";--> statement-breakpoint
CREATE TYPE "contribution_type" AS ENUM('comment', 'correction');--> statement-breakpoint
ALTER TABLE "contributions" ALTER COLUMN "type" TYPE "contribution_type"
  USING (case when "type"::text = 'correction' then 'correction' else 'comment' end)::"contribution_type";--> statement-breakpoint
DROP TYPE "contribution_type_old";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. stories: map the three retired submission types onto `original_brief`,
--    rewriting the JSONB metadata IN STEP so the strict schema keeps parsing
--    and `submissionBodyText()` keeps returning the author's text.
-- ---------------------------------------------------------------------------
UPDATE "stories" SET "submission_metadata" = jsonb_build_object(
    'submission_type', 'original_brief',
    'body', concat_ws(E'\n\n',
      nullif("submission_metadata"->>'question', ''),
      nullif("submission_metadata"->>'context', ''),
      nullif("submission_metadata"->>'source_or_experience_disclosure', ''),
      nullif("submission_metadata"->>'event_description', ''),
      nullif("submission_metadata"->>'time_reference', '')))
  WHERE "submission_metadata"->>'submission_type' IN ('question', 'local_update', 'live_thread');--> statement-breakpoint
ALTER TYPE "story_submission_type" RENAME TO "story_submission_type_old";--> statement-breakpoint
CREATE TYPE "story_submission_type" AS ENUM('link', 'original_brief', 'image_post', 'video_post');--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "submission_type" TYPE "story_submission_type"
  USING (case when "submission_type"::text in ('question', 'local_update', 'live_thread')
              then 'original_brief' else "submission_type"::text end)::"story_submission_type";--> statement-breakpoint
DROP TYPE "story_submission_type_old";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Durable event log: remap retired payload values so checkpoint recovery /
--    DLQ redrive keep parsing every row (rows that fail parse are silently
--    skipped — never acceptable for real submissions).
-- ---------------------------------------------------------------------------
UPDATE "events" SET "payload" = jsonb_set("payload", '{submission_type}', '"original_brief"')
  WHERE "topic" IN ('content.submitted', 'content.normalized')
    AND "payload"->>'submission_type' IN ('question', 'local_update', 'live_thread');--> statement-breakpoint
UPDATE "events" SET "payload" = jsonb_set("payload", '{contribution_type}',
    (case when "payload"->>'contribution_type' = 'flag' then '"low_info_reply"'
          else '"explanation"' end)::jsonb)
  WHERE "topic" = 'contribution.created'
    AND "payload"->>'contribution_type' IN ('question', 'synthesis', 'counterexample', 'experience', 'flag');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Never-read placeholder columns: the private reputation summary (two of
--    the three scores never had a writer; the bridge counter wrote an
--    unbounded count into a [0,1] probability field, and no surface ever read
--    any of it — the SCOI-2 credit itself stays on scoi_bridge_attempts) and
--    the per-room notification preferences (no notifier ever read them).
-- ---------------------------------------------------------------------------
ALTER TABLE "users" DROP COLUMN IF EXISTS "reputation_summary_private";--> statement-breakpoint
ALTER TABLE "room_subscriptions" DROP COLUMN IF EXISTS "notification_preferences";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4b. Review queue: the `moderation_concern` kind was fed ONLY by the retired
--     moderation_concern contribution intake (WS-J reports intake through its
--     own WS-J tables).  Stray rows fold into the surviving forum-intake kind
--     inside the recreate's USING map (labels of the freshly CREATEd type are
--     safe in-transaction; a standalone UPDATE writing the label added by an
--     earlier migration's ADD VALUE would hit 55P04 on a fresh single-
--     transaction bootstrap).
-- ---------------------------------------------------------------------------
ALTER TYPE "ingestion_review_kind" RENAME TO "ingestion_review_kind_old";--> statement-breakpoint
CREATE TYPE "ingestion_review_kind" AS ENUM('near_duplicate', 'syndication_candidate', 'extraction_failure', 'url_safety_hold', 'low_confidence_claim', 'contribution_safety_hold');--> statement-breakpoint
ALTER TABLE "ingestion_review_items" ALTER COLUMN "kind" TYPE "ingestion_review_kind"
  USING (case when "kind"::text = 'moderation_concern' then 'contribution_safety_hold'
              else "kind"::text end)::"ingestion_review_kind";--> statement-breakpoint
DROP TYPE "ingestion_review_kind_old";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. uploads: PDF documents had no client path (the composer offers
--    images/video/captions only).  Dev-only PDF rows are removed (their
--    upload_blobs cascade) and the CHECK is recreated without the type
--    (the 0021 swap pattern).
-- ---------------------------------------------------------------------------
DELETE FROM "uploads" WHERE "content_type" = 'application/pdf';--> statement-breakpoint
ALTER TABLE "uploads" DROP CONSTRAINT "uploads_content_type_allowed";--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_content_type_allowed" CHECK ("uploads"."content_type" in ('image/jpeg','image/png','image/webp','image/avif','image/gif','video/mp4','video/webm','text/vtt')) NOT VALID;--> statement-breakpoint
ALTER TABLE "uploads" VALIDATE CONSTRAINT "uploads_content_type_allowed";
