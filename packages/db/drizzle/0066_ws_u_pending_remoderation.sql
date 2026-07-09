-- WS-U ADR-9 — the deferred re-moderation queue.
--
-- When the in-room moderation MODEL (an LLM) is UNAVAILABLE for a contribution
-- (an outage), the platform keeps the always-on WS-J baseline decision AND
-- enqueues the contribution here, so the model's own judgment is RETRIED later
-- rather than dropped ("delayed, never dropped"). The governance scheduler sweep
-- RECONSTRUCTS the moderation context from the live forum/content stores at retry
-- time (never persisted here), re-runs the model, and on a decided restriction
-- raises the already-published contribution to human review post-hoc; a benign,
-- moot, or already-deleted item is removed. Exactly one row per
-- (room, contribution) — a re-defer UPSERTs on the composite PK, never
-- duplicating. `subject_ref` is a SOFT ref to the contribution (no FK: the
-- knomosis context never hard-joins the content/ranking tables — the structural
-- no-pay-to-rank isolation, WS-D.3.2).
--
-- PRIVACY: this table holds ONLY soft refs + retry bookkeeping — NO contribution
-- text or any content field (so a contribution deletion/anonymization has nothing
-- to purge here; a dangling subject_ref is self-cleaned on the next sweep). NO
-- wallet/payment/treasury/financial column appears here either (SPEC §21.5).
CREATE TABLE "knomosis"."room_pending_remoderation" (
	"room_id" uuid NOT NULL,
	"subject_ref" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	CONSTRAINT "room_pending_remoderation_room_id_subject_ref_pk" PRIMARY KEY("room_id","subject_ref")
);
--> statement-breakpoint
CREATE INDEX "room_pending_remoderation_enqueued_idx" ON "knomosis"."room_pending_remoderation" USING btree ("enqueued_at");
