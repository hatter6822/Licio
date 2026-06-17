-- WS-J right-to-erasure: scrub the account UUID from moderation_audit.target_id.
--
-- For an account-target audit row, `target_id` holds the account's user UUID, but
-- the polymorphic `target_id` is NOT a foreign key, so the `ON DELETE SET NULL`
-- cascades that scrub `actor_user_id`/`subject_user_id`/`co_approver_user_id`
-- cannot reach it.  A hard purge therefore left the erased account's stable id in
-- the immutable audit log.  This migration (1) relaxes the append-only trigger to
-- permit NULLing `target_id` (mirroring the user-reference columns), and (2) adds
-- a BEFORE DELETE trigger on `users` that NULLs it for account-target rows — so a
-- hard purge leaves no stable account id behind.  `moderation_audit.target_id` is
-- already nullable; no column change is required here.
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
	  OR NEW."prior_state"      IS DISTINCT FROM OLD."prior_state"
	  OR NEW."next_state"       IS DISTINCT FROM OLD."next_state"
	  OR NEW."reversible"       IS DISTINCT FROM OLD."reversible"
	  OR NEW."linked_action_id" IS DISTINCT FROM OLD."linked_action_id"
	  OR NEW."report_ids"       IS DISTINCT FROM OLD."report_ids"
	  OR NEW."notes"            IS DISTINCT FROM OLD."notes"
	  OR NEW."created_at"       IS DISTINCT FROM OLD."created_at"
	  OR (NEW."target_id"           IS DISTINCT FROM OLD."target_id"           AND NEW."target_id"           IS NOT NULL)
	  OR (NEW."actor_user_id"       IS DISTINCT FROM OLD."actor_user_id"       AND NEW."actor_user_id"       IS NOT NULL)
	  OR (NEW."subject_user_id"     IS DISTINCT FROM OLD."subject_user_id"     AND NEW."subject_user_id"     IS NOT NULL)
	  OR (NEW."co_approver_user_id" IS DISTINCT FROM OLD."co_approver_user_id" AND NEW."co_approver_user_id" IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'moderation_audit is append-only (only right-to-erasure NULLing of user references is permitted)';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "moderation_audit_scrub_account_target"() RETURNS trigger AS $$
BEGIN
	UPDATE "moderation_audit"
	   SET "target_id" = NULL
	 WHERE "target_type" = 'account' AND "target_id" = OLD."user_id";
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "moderation_audit_scrub_on_user_delete" BEFORE DELETE ON "users" FOR EACH ROW EXECUTE FUNCTION "moderation_audit_scrub_account_target"();
