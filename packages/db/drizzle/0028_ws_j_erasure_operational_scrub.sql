-- WS-J right-to-erasure (closes the 0026 residual): the polymorphic `target_id`
-- holds an `account` target's user UUID but is NOT a foreign key, so the
-- ON DELETE SET NULL cascades that scrub `subject_user_id`/`reporter_user_id`/…
-- cannot reach it.  Make it nullable on the four OPERATIONAL tables (the audit
-- log was already nullable + scrubbed in 0026) so a hard purge can NULL it.
-- NULLs stay DISTINCT in the open-target partial unique indexes
-- (`moderation_cases_open_target_uq`, `coordinated_report_incidents_target_open_uq`),
-- so several erased-account rows never collide (a sentinel value would).
ALTER TABLE "coordinated_report_incidents" ALTER COLUMN "target_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_actions" ALTER COLUMN "target_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_cases" ALTER COLUMN "target_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_reports" ALTER COLUMN "target_id" DROP NOT NULL;--> statement-breakpoint
-- Extend the 0026 user-delete scrub to the operational tables.  CREATE OR REPLACE
-- broadens the existing function (the `moderation_audit_scrub_on_user_delete`
-- BEFORE DELETE trigger on `users` already calls it); the audit-log scrub is
-- preserved, and a hard purge now leaves NO stable account id in ANY moderation
-- table for an `account` target.
CREATE OR REPLACE FUNCTION "moderation_audit_scrub_account_target"() RETURNS trigger AS $$
BEGIN
	UPDATE "moderation_audit"             SET "target_id" = NULL WHERE "target_type" = 'account' AND "target_id" = OLD."user_id";
	UPDATE "moderation_cases"             SET "target_id" = NULL WHERE "target_type" = 'account' AND "target_id" = OLD."user_id";
	UPDATE "moderation_reports"           SET "target_id" = NULL WHERE "target_type" = 'account' AND "target_id" = OLD."user_id";
	UPDATE "moderation_actions"           SET "target_id" = NULL WHERE "target_type" = 'account' AND "target_id" = OLD."user_id";
	UPDATE "coordinated_report_incidents" SET "target_id" = NULL WHERE "target_type" = 'account' AND "target_id" = OLD."user_id";
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;