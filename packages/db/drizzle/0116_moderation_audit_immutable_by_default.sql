-- WS-J.2.5 — make the audit trail's immutability hold for columns nobody has added yet.
--
-- `moderation_audit_no_mutate` enumerated the columns an UPDATE may not change.  An
-- enumeration is an allowlist by OMISSION: every column added after it was written is
-- silently mutable, and the trigger reads as though it protects the row when it protects
-- a list.  Migration 0115's `ordinal` landed straight into that gap — the pagination key,
-- and the sequence a tamper-evident chain has to be defined over, freely rewritable by an
-- UPDATE the trigger would wave through.
--
-- Inverted here: EVERY column must be byte-identical except the four the right-to-erasure
-- scrub is allowed to NULL (SPEC §19.2 / the WS-D account purge), and those may only move
-- TOWARDS null.  A new column is immutable the moment it exists, with no trigger edit and
-- no way to forget one.
--
-- `to_jsonb(NEW/OLD)` compares the whole row at once.  It costs a serialization per
-- UPDATE, which is free in practice: the only UPDATE that ever reaches this table is an
-- erasure scrub.
CREATE OR REPLACE FUNCTION "moderation_audit_no_mutate"() RETURNS trigger AS $$
DECLARE
	-- The ONLY columns an update may touch, and only ever to NULL.
	scrubbable CONSTANT text[] := ARRAY['target_id', 'actor_user_id', 'subject_user_id', 'co_approver_user_id'];
	old_rest jsonb := to_jsonb(OLD);
	new_rest jsonb := to_jsonb(NEW);
	col text;
BEGIN
	IF (TG_OP = 'DELETE') THEN
		RAISE EXCEPTION 'moderation_audit is append-only (no DELETE)';
	END IF;
	FOREACH col IN ARRAY scrubbable LOOP
		-- A scrubbable column may change, but only to NULL.
		IF ((to_jsonb(NEW) ->> col) IS DISTINCT FROM (to_jsonb(OLD) ->> col))
			AND (to_jsonb(NEW) ->> col) IS NOT NULL THEN
			RAISE EXCEPTION 'moderation_audit is append-only (only right-to-erasure NULLing of user references is permitted)';
		END IF;
		old_rest := old_rest - col;
		new_rest := new_rest - col;
	END LOOP;
	-- Everything else — including every column added after this migration — must be
	-- identical.  This is the clause `ordinal` needed and did not have.
	IF new_rest IS DISTINCT FROM old_rest THEN
		RAISE EXCEPTION 'moderation_audit is append-only (only right-to-erasure NULLing of user references is permitted)';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
