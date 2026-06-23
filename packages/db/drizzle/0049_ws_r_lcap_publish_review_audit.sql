-- Gate-19 (WS-R.15.7b, OFFLINE_SPEC §22.7) — the required privacy/moderation/abuse-review
-- gate state + the append-only public-DHT (re)publish decision audit.
--
-- `lcap_block_publish_review` records the affirmative review decision per content entity
-- (the same `(target_type, target_id)` coordinate a takedown / `lcap_block_provenance`
-- uses): a public block is publishable only when its source content entity is `approved`.
--
-- `lcap_publish_audit` is the append-only trail of every (re)publish ATTEMPT — pinned OR
-- refused — capturing the actor, the block, the resolved target, the §22.7 review-gate
-- verdict, the takedown re-check verdict, and the final outcome.  The append-only trigger
-- mirrors the WS-J `moderation_audit` posture: no UPDATE/DELETE, EXCEPT the right-to-erasure
-- NULLing of `actor_user_id` (so a WS-D account hard-purge of a logged steward succeeds while
-- the decision record stays immutable).  Both `*_user_id` columns FK `set null` on purge.
CREATE TABLE "lcap_block_publish_review" (
	"target_type" "takedown_target_type" NOT NULL,
	"target_id" text NOT NULL,
	"state" text NOT NULL,
	"reviewer_user_id" uuid,
	"note" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lcap_block_publish_review_target_type_target_id_pk" PRIMARY KEY("target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "lcap_publish_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"block_cid" text NOT NULL,
	"target_type" "takedown_target_type",
	"target_id" text,
	"actor_user_id" uuid,
	"review_verdict" text NOT NULL,
	"takedown_verdict" text NOT NULL,
	"published" boolean NOT NULL,
	"outcome_reason" text NOT NULL,
	"ipfs_cid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lcap_block_publish_review" ADD CONSTRAINT "lcap_block_publish_review_reviewer_user_id_users_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lcap_publish_audit" ADD CONSTRAINT "lcap_publish_audit_actor_user_id_users_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lcap_block_publish_review_state_idx" ON "lcap_block_publish_review" USING btree ("state");--> statement-breakpoint
CREATE INDEX "lcap_publish_audit_block_idx" ON "lcap_publish_audit" USING btree ("block_cid");--> statement-breakpoint
CREATE INDEX "lcap_publish_audit_created_idx" ON "lcap_publish_audit" USING btree ("created_at");--> statement-breakpoint
-- Append-only: no DELETE; UPDATE permitted ONLY to NULL `actor_user_id` (right-to-erasure),
-- exactly like the WS-J moderation audit.  TRUNCATE (table-owner only) is intentionally not
-- blocked so test fixtures can reset; the application role cannot TRUNCATE in production.
CREATE OR REPLACE FUNCTION "lcap_publish_audit_no_mutate"() RETURNS trigger AS $$
BEGIN
	IF (TG_OP = 'DELETE') THEN
		RAISE EXCEPTION 'lcap_publish_audit is append-only (no DELETE)';
	END IF;
	IF ( NEW."id"               IS DISTINCT FROM OLD."id"
	  OR NEW."action"           IS DISTINCT FROM OLD."action"
	  OR NEW."block_cid"        IS DISTINCT FROM OLD."block_cid"
	  OR NEW."target_type"      IS DISTINCT FROM OLD."target_type"
	  OR NEW."target_id"        IS DISTINCT FROM OLD."target_id"
	  OR NEW."review_verdict"   IS DISTINCT FROM OLD."review_verdict"
	  OR NEW."takedown_verdict" IS DISTINCT FROM OLD."takedown_verdict"
	  OR NEW."published"        IS DISTINCT FROM OLD."published"
	  OR NEW."outcome_reason"   IS DISTINCT FROM OLD."outcome_reason"
	  OR NEW."ipfs_cid"         IS DISTINCT FROM OLD."ipfs_cid"
	  OR NEW."created_at"       IS DISTINCT FROM OLD."created_at"
	  OR (NEW."actor_user_id"   IS DISTINCT FROM OLD."actor_user_id" AND NEW."actor_user_id" IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'lcap_publish_audit is append-only (only right-to-erasure NULLing of actor_user_id is permitted)';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "lcap_publish_audit_append_only" BEFORE UPDATE OR DELETE ON "lcap_publish_audit" FOR EACH ROW EXECUTE FUNCTION "lcap_publish_audit_no_mutate"();
