-- WS-M.4.3c — erasure-safe governance audit chain.
--
-- The hash chain previously folded the RAW, erasable `actor_user_id` into its
-- SHA-256 preimage.  Right-to-erasure NULLs `actor_user_id` (the trigger below
-- permits exactly that), which permanently broke `verifyAuditChain` for every
-- entry the erased user touched — a false tamper alarm that ALSO masks genuine
-- tampering.  We now hash a NON-REVERSIBLE `actor_ref` (an HMAC of the user id,
-- via `accountRef`) instead, mirroring the WS-N compliance chains: the raw
-- `actor_user_id` stays as an erasure-NULLable DISPLAY column while the frozen
-- `actor_ref` keeps the chain verifiable forever.
--
-- `actor_ref` is nullable: WS-L.4 (non-chained) rows and system rows carry no
-- actor.  Existing chained rows are empty in every real deployment (this table
-- is never seeded and governance is pre-launch), so no re-anchor is required.
ALTER TABLE "knomosis"."governance_audit_log" ADD COLUMN "actor_ref" text;--> statement-breakpoint

-- Recreate the append-only trigger so `actor_ref` is FROZEN too (append-once).
-- `actor_user_id` remains mutable ONLY to NULL (right-to-erasure); every other
-- column — now including `actor_ref` — is immutable after insert.
CREATE OR REPLACE FUNCTION "knomosis"."governance_audit_no_mutate"() RETURNS trigger AS $$
BEGIN
	IF (TG_OP = 'DELETE') THEN
		RAISE EXCEPTION 'governance_audit_log is append-only (no DELETE)';
	END IF;
	IF ( NEW."entry_id"        IS DISTINCT FROM OLD."entry_id"
	  OR NEW."room_id"         IS DISTINCT FROM OLD."room_id"
	  OR NEW."action_type"     IS DISTINCT FROM OLD."action_type"
	  OR NEW."action_details"  IS DISTINCT FROM OLD."action_details"
	  OR NEW."simulation_mode" IS DISTINCT FROM OLD."simulation_mode"
	  OR NEW."created_at"      IS DISTINCT FROM OLD."created_at"
	  OR NEW."prev_hash"       IS DISTINCT FROM OLD."prev_hash"
	  OR NEW."integrity_hash"  IS DISTINCT FROM OLD."integrity_hash"
	  OR NEW."actor_ref"       IS DISTINCT FROM OLD."actor_ref"
	  OR NEW."proposal_id"     IS DISTINCT FROM OLD."proposal_id"
	  OR NEW."treasury_id"     IS DISTINCT FROM OLD."treasury_id"
	  OR (NEW."actor_user_id"  IS DISTINCT FROM OLD."actor_user_id" AND NEW."actor_user_id" IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'governance_audit_log is append-only (only right-to-erasure NULLing of actor_user_id is permitted)';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
