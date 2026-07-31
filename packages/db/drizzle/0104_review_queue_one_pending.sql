-- At most ONE pending review item per (kind, subject) — a database invariant.
--
-- `POST /v1/ai/summaries/:id/report` and `/v1/ai/translations/:id/report` insert
-- an `ai_review_queue` row per report.  Both are authenticated, neither was rate
-- limited, and neither deduplicated: one account could report the same summary
-- in a loop and mint an unbounded number of queue rows.  That is two defects at
-- once — an unbounded write from a single caller, and a steward queue in which
-- one summary appears five hundred times, which is how a real item goes unseen.
--
-- The right shape is one ITEM per subject with the report COUNT beside it (the
-- reports themselves are still recorded in full, in `ai_summary_reports` /
-- `ai_translation_reports`, where the volume belongs).  Enforcing that in the
-- insert path alone would leave it a convention two adapters have to remember
-- and a concurrent pair of reports could still break; a partial unique index
-- makes it true of the table.
--
-- Partial on `status = 'pending'` deliberately: a RESOLVED item must not block a
-- later report from opening a fresh one, which is what makes a re-report after a
-- steward decision visible again.
--
-- Existing duplicates are collapsed to the OLDEST pending row per (kind,
-- subject) — the one whose position in the queue a steward may already have
-- seen. `resolved` rows are untouched: they are the audit record.
DELETE FROM "ai_review_queue" a
  USING "ai_review_queue" b
  WHERE a."status" = 'pending'
    AND b."status" = 'pending'
    AND a."kind" = b."kind"
    AND a."subject_ref" = b."subject_ref"
    AND (a."created_at", a."review_id") > (b."created_at", b."review_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_review_queue_pending_subject_uq"
  ON "ai_review_queue" ("kind", "subject_ref")
  WHERE "status" = 'pending';
