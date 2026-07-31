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
--
-- THE TRIGGER HAS TO COME OFF FOR THIS, and the reason is the previous migration.  0116
-- inverted `moderation_audit_no_mutate` so that EVERY column is frozen except the four
-- the right-to-erasure scrub may NULL — deliberately, so a column added later is
-- immutable the moment it exists.  `case_id` is such a column, and this backfill is such
-- an update: the trigger refuses it, aborting the statement, the migration and every
-- migration after it.
--
-- On a database where no audit row carries a `linked_action_id` pointing at a cased
-- action the UPDATE touches nothing, no trigger fires, and the chain applies cleanly —
-- which is exactly what a development database looks like, and exactly why this passed
-- until it was reasoned about rather than run.  `moderation-audit-immutability.test.ts`
-- asserts the refusal directly ("REFUSES to rewrite the case binding"), so the proof it
-- would abort was already in the suite.
--
-- Scoped as narrowly as it can be: this one statement, on this one table, inside the
-- migration's transaction, re-enabled immediately.  A failure rolls the whole thing back
-- with the trigger still attached.
ALTER TABLE "moderation_audit" DISABLE TRIGGER "moderation_audit_append_only";
--> statement-breakpoint
UPDATE "moderation_audit" m
   SET "case_id" = a."case_id"
  FROM "moderation_actions" a
 WHERE m."linked_action_id" = a."action_id"
   AND a."case_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "moderation_audit" ENABLE TRIGGER "moderation_audit_append_only";
--> statement-breakpoint
-- `(case_id, ordinal DESC)` is the per-case history read exactly: filter then walk the
-- keyset.  `NULLS LAST` is irrelevant to that read but keeps the index compact for the
-- case-scoped scan rather than the (large) uncased remainder.
CREATE INDEX "moderation_audit_case_ordinal_idx"
    ON "moderation_audit" ("case_id", "ordinal" DESC)
 WHERE "case_id" IS NOT NULL;
