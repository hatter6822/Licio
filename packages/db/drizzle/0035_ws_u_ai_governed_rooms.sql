CREATE SCHEMA "knomosis";
--> statement-breakpoint
CREATE TYPE "knomosis"."governance_vote_mode" AS ENUM('simulated', 'testnet', 'onchain');--> statement-breakpoint
CREATE TYPE "knomosis"."room_model_status" AS ENUM('proposed', 'evaluating', 'eligible', 'rejected', 'approved', 'superseded');--> statement-breakpoint
CREATE TYPE "knomosis"."steward_election_status" AS ENUM('scheduled', 'open', 'tallying', 'settled', 'cancelled');--> statement-breakpoint
CREATE TABLE "knomosis"."agent_action_log" (
	"action_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"binding_model_id" uuid NOT NULL,
	"prompt_hash" text NOT NULL,
	"action_type" text NOT NULL,
	"subject_ref" text NOT NULL,
	"law_pack_rule_ref" text,
	"statement_of_reasons" text NOT NULL,
	"reversible" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knomosis"."agent_treasury_action" (
	"action_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"category" text NOT NULL,
	"amount" numeric NOT NULL,
	"asset" text,
	"accepted" boolean NOT NULL,
	"verdict" jsonb NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knomosis"."room_agent_binding" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"model_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"law_pack_id" uuid,
	"approved_by_election_id" uuid,
	"capability_descriptor" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knomosis"."room_governance_model" (
	"model_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"artifact_digest" text NOT NULL,
	"bundle_document" jsonb NOT NULL,
	"card_ref" uuid,
	"proposed_by_user_id" uuid,
	"status" "knomosis"."room_model_status" DEFAULT 'proposed' NOT NULL,
	"evaluation_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knomosis"."room_governance_prompt" (
	"prompt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"prompt_digest" text NOT NULL,
	"prompt_text" text NOT NULL,
	"proposed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knomosis"."room_law_pack" (
	"law_pack_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"version" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knomosis"."room_steward_seat" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"holder_user_id" uuid,
	"term_start" timestamp with time zone DEFAULT now() NOT NULL,
	"term_end" timestamp with time zone NOT NULL,
	"bootstrap" boolean DEFAULT true NOT NULL,
	"current_election_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knomosis"."steward_election" (
	"election_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"status" "knomosis"."steward_election_status" DEFAULT 'scheduled' NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"weight_model" text DEFAULT 'one_civic_account_one_vote' NOT NULL,
	"winner_user_id" uuid,
	"tally" jsonb,
	"mode" "knomosis"."governance_vote_mode" DEFAULT 'simulated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knomosis"."steward_governance_vote" (
	"election_id" uuid NOT NULL,
	"voter_user_id" uuid NOT NULL,
	"candidate_user_id" uuid NOT NULL,
	"weight" numeric NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knomosis"."room_agent_binding" ADD CONSTRAINT "room_agent_binding_model_id_room_governance_model_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "knomosis"."room_governance_model"("model_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."room_agent_binding" ADD CONSTRAINT "room_agent_binding_prompt_id_room_governance_prompt_prompt_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "knomosis"."room_governance_prompt"("prompt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."room_agent_binding" ADD CONSTRAINT "room_agent_binding_law_pack_id_room_law_pack_law_pack_id_fk" FOREIGN KEY ("law_pack_id") REFERENCES "knomosis"."room_law_pack"("law_pack_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."room_governance_model" ADD CONSTRAINT "room_governance_model_proposed_by_user_id_users_user_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."room_governance_prompt" ADD CONSTRAINT "room_governance_prompt_model_id_room_governance_model_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "knomosis"."room_governance_model"("model_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."room_governance_prompt" ADD CONSTRAINT "room_governance_prompt_proposed_by_user_id_users_user_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."room_steward_seat" ADD CONSTRAINT "room_steward_seat_holder_user_id_users_user_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."steward_election" ADD CONSTRAINT "steward_election_winner_user_id_users_user_id_fk" FOREIGN KEY ("winner_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."steward_governance_vote" ADD CONSTRAINT "steward_governance_vote_election_id_steward_election_election_id_fk" FOREIGN KEY ("election_id") REFERENCES "knomosis"."steward_election"("election_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."steward_governance_vote" ADD CONSTRAINT "steward_governance_vote_voter_user_id_users_user_id_fk" FOREIGN KEY ("voter_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knomosis"."steward_governance_vote" ADD CONSTRAINT "steward_governance_vote_candidate_user_id_users_user_id_fk" FOREIGN KEY ("candidate_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_action_log_room_idx" ON "knomosis"."agent_action_log" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "agent_treasury_action_room_idx" ON "knomosis"."agent_treasury_action" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_governance_model_room_idx" ON "knomosis"."room_governance_model" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_law_pack_room_idx" ON "knomosis"."room_law_pack" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "steward_election_room_idx" ON "knomosis"."steward_election" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "steward_vote_pk" ON "knomosis"."steward_governance_vote" USING btree ("election_id","voter_user_id");