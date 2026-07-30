-- WS-J.2.5 — make the moderation audit trail tamper-EVIDENT, not merely append-only.
--
-- Append-only says nothing about a writer that reaches the table another way.  The
-- trigger refuses UPDATE and DELETE through the ordinary path; it cannot speak for a
-- superuser session, a restore from a doctored dump, or a migration.  A chain can: each
-- entry commits to its predecessor, so an alteration anywhere invalidates every hash
-- after it, and the alteration cannot be repaired without the key.
--
-- Same shape as the governance log's chain (migration 0082), with one difference: that
-- chain is per room, this one is global, so the parent slot is unique across the table
-- rather than within a partition.
--
-- The RETROFIT is what the partial predicates are for.  Rows written before this
-- migration have NULL in both columns and are simply not chained — they do not collide
-- with the genesis index (which requires a non-null hash), and the first entry written
-- after this becomes the genesis of a chain that runs forward from there.  No backfill
-- can honestly chain the past: a hash computed now over rows that were never committed
-- to proves only that they are self-consistent today, which is precisely the claim a
-- chain is supposed to be unable to make.
ALTER TABLE "moderation_audit" ADD COLUMN "prev_hash" text;
--> statement-breakpoint
ALTER TABLE "moderation_audit" ADD COLUMN "integrity_hash" text;
--> statement-breakpoint
-- FORK-PROOF.  Two writers that both read the same head produce two entries claiming the
-- same parent; the unique index lets exactly one land and the loser retries against the
-- new head.  Without it the chain silently forks and both branches verify in isolation.
CREATE UNIQUE INDEX "moderation_audit_chain_parent_uq"
    ON "moderation_audit" ("prev_hash") WHERE "prev_hash" IS NOT NULL;
--> statement-breakpoint
-- Exactly ONE genesis for the whole table.  The constant index expression makes every
-- qualifying row collide with every other, which is the singleton constraint.
CREATE UNIQUE INDEX "moderation_audit_chain_genesis_uq"
    ON "moderation_audit" ((true)) WHERE "prev_hash" IS NULL AND "integrity_hash" IS NOT NULL;
--> statement-breakpoint
-- The verifier walks forward from the genesis and must find EVERY later row chained; the
-- head read takes the greatest chained ordinal.  Both are this index.
CREATE INDEX "moderation_audit_chain_ordinal_idx"
    ON "moderation_audit" ("ordinal") WHERE "integrity_hash" IS NOT NULL;
