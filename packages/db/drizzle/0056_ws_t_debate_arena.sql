-- WS-T — sourced-correction debate arena (SPEC §15.4/§24.6). Additive.
--
-- A sourced correction against a comment or story opens a live debate arena.
-- The two sides' co-visible position drafts live in `positions` JSONB; every
-- queryable/orderable field (target, state, deadlines, verdict, override) is a
-- first-class column. The AI verdict references its immutable AIOutputRecord id
-- (audit trail), never inlined.
--
-- Dispute posture is ORTHOGONAL to moderation/hidden state: an `incorrect`
-- contribution/story stays fully VISIBLE but sinks to the bottom of its section
-- / the feed and carries an "incorrect" tag — the transparency remedy, never a
-- tombstone. Existing rows default to `none`.
--
-- NO wallet/payment/treasury/financial column appears here (SPEC §21.5/§13.6):
-- the debate outcome is content-structural, never funded.
CREATE TYPE "public"."contribution_dispute_status" AS ENUM('none', 'under_debate', 'incorrect');--> statement-breakpoint
CREATE TYPE "public"."story_dispute_status" AS ENUM('none', 'under_debate', 'incorrect');--> statement-breakpoint
CREATE TYPE "public"."debate_state" AS ENUM('open', 'awaiting_verdict', 'judged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."debate_target_type" AS ENUM('comment', 'story');--> statement-breakpoint
CREATE TYPE "public"."debate_verdict" AS ENUM('upheld', 'corrected', 'inconclusive');--> statement-breakpoint
CREATE TYPE "public"."debate_winner" AS ENUM('incumbent', 'challenger', 'none');--> statement-breakpoint
CREATE TYPE "public"."debate_decider" AS ENUM('ai', 'steward');--> statement-breakpoint
CREATE TABLE "debate_arenas" (
	"debate_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"thread_id" uuid,
	"room_id" uuid,
	"target_type" "debate_target_type" NOT NULL,
	"target_contribution_id" uuid,
	"challenger_contribution_id" uuid NOT NULL,
	"incumbent_user_id" uuid,
	"challenger_user_id" uuid,
	"state" "debate_state" DEFAULT 'open' NOT NULL,
	"positions" jsonb NOT NULL,
	"edit_deadline_at" timestamp with time zone NOT NULL,
	"verdict" "debate_verdict",
	"winner" "debate_winner",
	"decided_by" "debate_decider",
	"rationale" text,
	"confidence" double precision,
	"ai_output_id" text,
	"verdict_at" timestamp with time zone,
	"override_deadline_at" timestamp with time zone,
	"overridden_by_user_id" uuid,
	"override_reason" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "debate_arenas_confidence_range" CHECK ("debate_arenas"."confidence" is null or ("debate_arenas"."confidence" >= 0 and "debate_arenas"."confidence" <= 1)),
	CONSTRAINT "debate_arenas_target_consistent" CHECK (("debate_arenas"."target_type" = 'comment') = ("debate_arenas"."target_contribution_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "dispute_status" "contribution_dispute_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "dispute_status" "story_dispute_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD CONSTRAINT "debate_arenas_story_id_stories_story_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("story_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD CONSTRAINT "debate_arenas_thread_id_threads_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("thread_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD CONSTRAINT "debate_arenas_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD CONSTRAINT "debate_arenas_target_contribution_id_contributions_contribution_id_fk" FOREIGN KEY ("target_contribution_id") REFERENCES "public"."contributions"("contribution_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD CONSTRAINT "debate_arenas_challenger_contribution_id_contributions_contribution_id_fk" FOREIGN KEY ("challenger_contribution_id") REFERENCES "public"."contributions"("contribution_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD CONSTRAINT "debate_arenas_incumbent_user_id_users_user_id_fk" FOREIGN KEY ("incumbent_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD CONSTRAINT "debate_arenas_challenger_user_id_users_user_id_fk" FOREIGN KEY ("challenger_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_arenas" ADD CONSTRAINT "debate_arenas_overridden_by_user_id_users_user_id_fk" FOREIGN KEY ("overridden_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "debate_arenas_story_idx" ON "debate_arenas" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "debate_arenas_thread_idx" ON "debate_arenas" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "debate_arenas_target_contribution_idx" ON "debate_arenas" USING btree ("target_contribution_id");--> statement-breakpoint
CREATE INDEX "debate_arenas_challenger_idx" ON "debate_arenas" USING btree ("challenger_contribution_id");--> statement-breakpoint
CREATE INDEX "debate_arenas_state_edit_deadline_idx" ON "debate_arenas" USING btree ("state","edit_deadline_at");--> statement-breakpoint
CREATE INDEX "debate_arenas_state_override_deadline_idx" ON "debate_arenas" USING btree ("state","override_deadline_at");--> statement-breakpoint
CREATE UNIQUE INDEX "debate_arenas_open_comment_uq" ON "debate_arenas" USING btree ("target_contribution_id") WHERE "debate_arenas"."target_contribution_id" is not null and "debate_arenas"."state" <> 'resolved';--> statement-breakpoint
CREATE UNIQUE INDEX "debate_arenas_open_story_uq" ON "debate_arenas" USING btree ("story_id") WHERE "debate_arenas"."target_type" = 'story' and "debate_arenas"."state" <> 'resolved';--> statement-breakpoint
CREATE INDEX "contributions_thread_dispute_created_idx" ON "contributions" USING btree ("thread_id","dispute_status","created_at");
