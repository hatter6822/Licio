-- WS-Q.1.4c — tier-scoped canonical-URL uniqueness (§14.5.6), replacing the
-- global unique index with the public-global + room-scoped pair. The
-- `hidden_state IS NULL` predicate keeps a taken-down/safety-hidden row from
-- holding the live slot; the submission guard's canonical-URL takedown denylist
-- (WS-Q.2.2a/2.6) is the companion that preserves the takedown decision.
--
-- Transaction-safety note: drizzle's migrate() runs the whole chain in ONE
-- transaction, which forbids CREATE INDEX CONCURRENTLY. These are therefore
-- plain (locking) index builds — correct and instant on the fresh DB the gated
-- integration tests use. For a production deploy against a large `stories`
-- table, build the two new indexes CONCURRENTLY out-of-band first, then run a
-- trimmed version of this migration that only drops the old index.
CREATE UNIQUE INDEX "stories_canonical_url_public_uq" ON "stories" USING btree ("canonical_url") WHERE "stories"."canonical_url" is not null and "stories"."visibility" = 'public' and "stories"."hidden_state" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "stories_canonical_url_room_uq" ON "stories" USING btree ("canonical_url","room_id") WHERE "stories"."canonical_url" is not null and "stories"."visibility" = 'room_only' and "stories"."hidden_state" is null;--> statement-breakpoint
DROP INDEX "stories_canonical_url_uq";
