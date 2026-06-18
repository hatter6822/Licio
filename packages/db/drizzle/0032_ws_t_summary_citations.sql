-- WS-T.2.4 — accurate summary citation naming. Keep cited_branch_ids as a
-- retained read alias during this workstream; new writes target
-- cited_contribution_ids and compatibility reads can coalesce old rows.
ALTER TABLE "summaries" ADD COLUMN IF NOT EXISTS "cited_contribution_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "summaries"
SET "cited_contribution_ids" = "cited_branch_ids"
WHERE "cited_contribution_ids" = '[]'::jsonb
  AND "cited_branch_ids" <> '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_contribution_ids_array" CHECK (jsonb_typeof("summaries"."cited_contribution_ids") = 'array') NOT VALID;--> statement-breakpoint
ALTER TABLE "summaries" VALIDATE CONSTRAINT "summaries_contribution_ids_array";
