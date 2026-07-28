-- The takedown-denylist probe had no index and sequentially scanned `stories`.
--
-- `StoryStore.hasHiddenForUrl` asks "is there a HIDDEN story for this canonical
-- URL?" — the WS-Q.2.2a/2.6 takedown denylist.  It runs on every link
-- submission and on every author widen, i.e. on the hot write path:
--
--   select story_id from stories
--    where canonical_url = $1 and hidden_state is not null limit 1;
--
-- Migration 0017 dropped `stories_canonical_url_uq` (the last index on
-- `canonical_url` with no `hidden_state` restriction) in favour of the two
-- tier-scoped partial uniques, and BOTH of those carry `hidden_state is null`
-- in their predicate — the exact negation of this query's filter.  No remaining
-- index can serve it, so Postgres has been answering it with a `Seq Scan on
-- stories`, and it stays a seq scan even with `enable_seqscan = off` because no
-- index alternative exists at all.
--
-- The complement is what is missing, so the complement is what is added: the
-- same column, under the opposite predicate.  It stays small — hidden rows are
-- the rare case — while making the probe an index lookup rather than a scan
-- that grows with the corpus.
--
-- `stories_canonical_url_hidden_idx` is 32 bytes, well inside Postgres's
-- 63-byte identifier limit (`pnpm check:sql-identifiers`).
CREATE INDEX IF NOT EXISTS "stories_canonical_url_hidden_idx"
  ON "stories" USING btree ("canonical_url")
  WHERE "canonical_url" is not null and "hidden_state" is not null;
