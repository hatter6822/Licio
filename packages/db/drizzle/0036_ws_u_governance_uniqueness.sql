DROP INDEX "knomosis"."steward_vote_pk";--> statement-breakpoint
ALTER TABLE "knomosis"."steward_governance_vote" ADD CONSTRAINT "steward_governance_vote_election_id_voter_user_id_pk" PRIMARY KEY("election_id","voter_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_governance_model_room_digest_uq" ON "knomosis"."room_governance_model" USING btree ("room_id","artifact_digest");