-- WS-T.2.2 — media-only comments enter the unchanged contribution insert path
-- with body='', while the body-or-media invariant is enforced at the shared
-- schema and service boundary. Replace the CHECK with NOT VALID + VALIDATE to
-- avoid an AccessExclusive validation scan on large tables.
ALTER TABLE "contributions" DROP CONSTRAINT "contributions_body_len";--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_body_len" CHECK (char_length("contributions"."body") between 0 and 5000) NOT VALID;--> statement-breakpoint
ALTER TABLE "contributions" VALIDATE CONSTRAINT "contributions_body_len";
