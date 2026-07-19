-- Index hygiene from the deep audit.
--
-- (1) threads_story_idx and (2) lcap_block_provenance_block_idx are REDUNDANT:
-- their single column is already the LEADING column of a unique / primary-key
-- index (threads_story_branch_uq (story_id, branch_index); the block-provenance
-- PK (block_cid, target_type, target_id)), which serves `WHERE <col> = ?` via a
-- leftmost-prefix scan.  Dropping them removes write-amplification with no read
-- regression.
DROP INDEX IF EXISTS "threads_story_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "lcap_block_provenance_block_idx";--> statement-breakpoint

-- (3) "At most one stub per P2P room shell" was documented but only a plain
-- index — enforce it STRUCTURALLY with a unique index so a second stub for the
-- same room can never be inserted.
DROP INDEX IF EXISTS "private_room_stubs_room_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "private_room_stubs_room_uq" ON "private_room_stubs" USING btree ("room_server_id");--> statement-breakpoint
