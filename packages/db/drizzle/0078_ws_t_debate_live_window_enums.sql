-- WS-T — debate live-window vocabulary (enum recreate). Additive in effect.
--
-- The arena lifecycle gains a `locked` phase (the material is locked in before
-- the AI resolution queue) and a terminal `withdrawn` close (the challenger
-- retracted the correction during the open window — no verdict, nothing
-- tagged). `concession` records an incumbent who conceded during the open
-- window (the challenger prevails without adjudication).
--
-- RECREATE (rename → create → cast → drop, the 0076 pattern) instead of
-- ALTER TYPE ADD VALUE: the drizzle migrator runs a pending batch in ONE
-- transaction, and Postgres refuses to reference an enum value appended to an
-- EXISTING type inside the same transaction (55P04) — the follow-up
-- migration's partial unique indexes reference 'withdrawn'. A brand-new type
-- carries no such restriction. The state-referencing indexes are dropped
-- first and recreated after the swap (the partial uniques are rebuilt with
-- their new predicates in 0079).
--
-- NO wallet/payment/treasury/financial column appears here (SPEC §21.5/§13.6):
-- the debate outcome is content-structural, never funded.
DROP INDEX IF EXISTS "debate_arenas_open_comment_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "debate_arenas_open_story_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "debate_arenas_state_edit_deadline_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "debate_arenas_state_override_deadline_idx";--> statement-breakpoint
ALTER TYPE "public"."debate_state" RENAME TO "debate_state_old";--> statement-breakpoint
CREATE TYPE "public"."debate_state" AS ENUM('open', 'locked', 'awaiting_verdict', 'judged', 'resolved', 'withdrawn');--> statement-breakpoint
ALTER TABLE "debate_arenas" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "debate_arenas" ALTER COLUMN "state" SET DATA TYPE "public"."debate_state" USING "state"::text::"public"."debate_state";--> statement-breakpoint
ALTER TABLE "debate_arenas" ALTER COLUMN "state" SET DEFAULT 'open';--> statement-breakpoint
DROP TYPE "public"."debate_state_old";--> statement-breakpoint
ALTER TYPE "public"."debate_decider" RENAME TO "debate_decider_old";--> statement-breakpoint
CREATE TYPE "public"."debate_decider" AS ENUM('ai', 'steward', 'concession');--> statement-breakpoint
ALTER TABLE "debate_arenas" ALTER COLUMN "decided_by" SET DATA TYPE "public"."debate_decider" USING "decided_by"::text::"public"."debate_decider";--> statement-breakpoint
DROP TYPE "public"."debate_decider_old";--> statement-breakpoint
CREATE INDEX "debate_arenas_state_edit_deadline_idx" ON "debate_arenas" USING btree ("state","edit_deadline_at");--> statement-breakpoint
CREATE INDEX "debate_arenas_state_override_deadline_idx" ON "debate_arenas" USING btree ("state","override_deadline_at");
