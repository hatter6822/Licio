CREATE TYPE "knomosis"."model_ratification_choice" AS ENUM('approve', 'reject');--> statement-breakpoint
CREATE TYPE "knomosis"."model_ratification_outcome" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "knomosis"."model_ratification_status" AS ENUM('open', 'settled', 'cancelled');--> statement-breakpoint
CREATE TABLE "knomosis"."model_ratification_ballot" (
	"vote_id" uuid NOT NULL,
	"voter_user_id" uuid NOT NULL,
	"choice" "knomosis"."model_ratification_choice" NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_ratification_ballot_vote_id_voter_user_id_pk" PRIMARY KEY("vote_id","voter_user_id")
);
--> statement-breakpoint
CREATE TABLE "knomosis"."model_ratification" (
	"vote_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"law_pack_id" uuid,
	"status" "knomosis"."model_ratification_status" DEFAULT 'open' NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"min_quorum" integer NOT NULL,
	"opened_by_user_id" uuid,
	"tally" jsonb,
	"outcome" "knomosis"."model_ratification_outcome",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "knomosis"."model_ratification_ballot" ADD CONSTRAINT "model_ratification_ballot_vote_id_model_ratification_vote_id_fk" FOREIGN KEY ("vote_id") REFERENCES "knomosis"."model_ratification"("vote_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."model_ratification_ballot" ADD CONSTRAINT "model_ratification_ballot_voter_user_id_users_user_id_fk" FOREIGN KEY ("voter_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."model_ratification" ADD CONSTRAINT "model_ratification_model_id_room_governance_model_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "knomosis"."room_governance_model"("model_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."model_ratification" ADD CONSTRAINT "model_ratification_opened_by_user_id_users_user_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_ratification_room_idx" ON "knomosis"."model_ratification" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "model_ratification_model_idx" ON "knomosis"."model_ratification" USING btree ("model_id");