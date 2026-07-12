-- WS-T — the 24h live debate window + the both-sides-idle expedited path
-- (SPEC §15.4). Additive + index rebuild.
--
-- An arena now stays LIVE for up to 24 hours: `edit_deadline_at` becomes
-- open + 23h (both sides may adjust their underlying content and rebuttal
-- statement, the challenger may withdraw, the incumbent may concede),
-- `resolve_due_at` is the instant the debate enters the room's AI resolution
-- queue (open + 24h scheduled, pulled EARLIER to the lock instant once BOTH
-- sides have gone an hour without an edit), and `locked_at`/`locked_content`
-- record the snapshot of the material under debate (what the adjudicator
-- judges).  `incumbent_last_active_at`/`challenger_last_active_at` drive the
-- expedited path; both start at the arena's open instant.
--
-- Legacy rows (opened under the 12h edit window with no lock phase) backfill
-- `resolve_due_at` = their old edit deadline, so an already-due arena is
-- picked up by the resolution sweep exactly when it would have been judged,
-- and backfill both activity clocks from `created_at`.
--
-- The one-live-arena-per-target partial unique indexes are rebuilt to treat
-- the new terminal `withdrawn` like `resolved` (a withdrawn challenge frees
-- the target for a fresh arena).
--
-- NO wallet/payment/treasury/financial column appears here (SPEC §21.5/§13.6):
-- the debate outcome is content-structural, never funded.
ALTER TABLE "debate_arenas" ADD COLUMN "resolve_due_at" timestamp with time zone;--> statement-breakpoint
UPDATE "debate_arenas" SET "resolve_due_at" = "edit_deadline_at" WHERE "resolve_due_at" IS NULL;--> statement-breakpoint
ALTER TABLE "debate_arenas" ALTER COLUMN "resolve_due_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD COLUMN "locked_content" jsonb;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD COLUMN "incumbent_last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD COLUMN "challenger_last_active_at" timestamp with time zone;--> statement-breakpoint
-- Backfill each activity clock from the LATEST evidence of that side's
-- activity: the arena's creation instant or the side's last position edit
-- (`positions.*.updatedAt`), whichever is later — otherwise an arena whose
-- party edited shortly before deploy would look idle-since-creation and be
-- expedited on the first post-deploy sweep, cutting its live window short.
UPDATE "debate_arenas" SET "incumbent_last_active_at" = GREATEST(
  "created_at",
  COALESCE(NULLIF("positions"->'incumbent'->>'updatedAt', '')::timestamptz, "created_at")
) WHERE "incumbent_last_active_at" IS NULL;--> statement-breakpoint
UPDATE "debate_arenas" SET "challenger_last_active_at" = GREATEST(
  "created_at",
  COALESCE(NULLIF("positions"->'challenger'->>'updatedAt', '')::timestamptz, "created_at")
) WHERE "challenger_last_active_at" IS NULL;--> statement-breakpoint
ALTER TABLE "debate_arenas" ALTER COLUMN "incumbent_last_active_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "debate_arenas" ALTER COLUMN "challenger_last_active_at" SET NOT NULL;--> statement-breakpoint
-- Pre-live-window rows seeded `positions.challenger` VERBATIM with the
-- correction's body + citations (the correction WAS the opening position).
-- The redesign shows and judges the correction row itself as the challenger's
-- underlying content, with the position now a distinct rebuttal layer — so a
-- legacy row whose challenger position still equals its correction body would
-- display and score the same text twice. Reset exactly those verbatim copies
-- to the empty rebuttal; a position the challenger genuinely edited differs
-- from the correction body and is kept.
UPDATE "debate_arenas" SET "positions" = jsonb_set(
  "positions",
  '{challenger}',
  '{"summary": "", "citations": [], "updatedAt": null}'::jsonb
)
FROM "contributions" c
WHERE c."contribution_id" = "debate_arenas"."challenger_contribution_id"
  AND "debate_arenas"."positions"->'challenger'->>'summary' = c."body";--> statement-breakpoint
DROP INDEX IF EXISTS "debate_arenas_open_comment_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "debate_arenas_open_comment_uq" ON "debate_arenas" USING btree ("target_contribution_id") WHERE "debate_arenas"."target_contribution_id" is not null and "debate_arenas"."state" not in ('resolved', 'withdrawn');--> statement-breakpoint
DROP INDEX IF EXISTS "debate_arenas_open_story_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "debate_arenas_open_story_uq" ON "debate_arenas" USING btree ("story_id") WHERE "debate_arenas"."target_type" = 'story' and "debate_arenas"."state" not in ('resolved', 'withdrawn');--> statement-breakpoint
CREATE INDEX "debate_arenas_state_resolve_due_idx" ON "debate_arenas" USING btree ("state","resolve_due_at");--> statement-breakpoint
CREATE INDEX "debate_arenas_open_idle_idx" ON "debate_arenas" USING btree (greatest("incumbent_last_active_at", "challenger_last_active_at")) WHERE "debate_arenas"."state" = 'open';
