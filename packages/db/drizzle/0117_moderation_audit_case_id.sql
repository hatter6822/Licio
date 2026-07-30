-- WS-J.2.2 — bind each audit record to the CASE it belongs to.
--
-- `buildCaseReview`'s own comment says the panel renders "the reports, the (now empty)
-- user history, and the audit trail".  It renders no audit trail, and could not: the
-- trail records `target_id` and `subject_user_id`, so the only reconstruction available
-- was "everything that ever happened to this user or this content", which is a different
-- question from "what happened on this case" and answers it wrongly in both directions —
-- it sweeps in unrelated cases about the same subject, and misses case-scoped events
-- (assignment, routing) that name no target.
--
-- Deliberately NOT a foreign key.  `moderation_actions.case_id` carries ON DELETE SET
-- NULL, and that cascade is an UPDATE — which this table's append-only trigger rejects,
-- so the FK would turn a case deletion into a constraint failure rather than a scrub.
-- The plain-uuid posture is the one `evidence_decisions` already takes for the same
-- reason: a moderation record has to outlive the row it points at.
ALTER TABLE "moderation_audit" ADD COLUMN "case_id" uuid;
--> statement-breakpoint
-- Recover what is derivable: an audit row carrying `linked_action_id` names an action,
-- and the action knows its case.  Rows with no linked action (queue reads, automated
-- blocks) stay NULL — unknown, not "no case".
UPDATE "moderation_audit" m
   SET "case_id" = a."case_id"
  FROM "moderation_actions" a
 WHERE m."linked_action_id" = a."action_id"
   AND a."case_id" IS NOT NULL;
--> statement-breakpoint
-- `(case_id, ordinal DESC)` is the per-case history read exactly: filter then walk the
-- keyset.  `NULLS LAST` is irrelevant to that read but keeps the index compact for the
-- case-scoped scan rather than the (large) uncased remainder.
CREATE INDEX "moderation_audit_case_ordinal_idx"
    ON "moderation_audit" ("case_id", "ordinal" DESC)
 WHERE "case_id" IS NOT NULL;
