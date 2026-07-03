-- Topic catalog + author-proposed topics (SPEC §14.1/§24.1). Story `topic_ids`
-- now carry only AI-VALIDATED catalog topics; the author's raw picks land in a
-- new UNTRUSTED `proposed_topic_ids` column that the WS-K validator confirms
-- against the content on `content.normalized`. Additive, column-only: existing
-- rows default to the empty array (they predate author proposals), and their
-- already-trusted `topic_ids` are unaffected.
ALTER TABLE "stories" ADD COLUMN "proposed_topic_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
