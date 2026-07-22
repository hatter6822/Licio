-- 0095: unified public-content search (WS-F.3.1a extension).
-- Generated STORED tsvector columns + GIN indexes so forum comments
-- (contributions) and rooms join the full-text corpus alongside stories and
-- claims. A generated column may reference only its OWN row: a comment indexes
-- its body (weight B — the story corpus already covers title matches), a room
-- its name (A) + description/charter summary (B). `simple` configuration
-- (neither row carries a language tag). Backfill is implicit: adding a STORED
-- generated column computes it for every existing row.
ALTER TABLE "contributions" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(body, '')), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "contributions_search_gin" ON "contributions" USING gin ("search_tsv");--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(name, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '') || ' ' || coalesce(charter_summary, '')), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "rooms_search_gin" ON "rooms" USING gin ("search_tsv");
