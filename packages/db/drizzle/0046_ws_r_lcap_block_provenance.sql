CREATE TABLE "lcap_block_provenance" (
	"block_cid" text NOT NULL,
	"target_type" "takedown_target_type" NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lcap_block_provenance_block_cid_target_type_target_id_pk" PRIMARY KEY("block_cid","target_type","target_id")
);
--> statement-breakpoint
CREATE INDEX "lcap_block_provenance_block_idx" ON "lcap_block_provenance" USING btree ("block_cid");--> statement-breakpoint
CREATE INDEX "lcap_block_provenance_target_idx" ON "lcap_block_provenance" USING btree ("target_type","target_id");