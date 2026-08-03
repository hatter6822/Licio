-- WS-H.7.4 — the index the Civic Map's landscape read actually needs.
--
-- `assembleEngagementLandscape` asks for one hour's active items, busiest
-- first, and the only supporting index was on `window_start` alone — so the
-- planner fetched every row in that hour and sorted it by `event_count` before
-- the LIMIT could apply.  The landscape then calls it with growing limits while
-- it scans past restricted stories, repeating that full-hour sort several times
-- for a single interactive page load.
--
-- PARTIAL on `event_count > 0`: a zero row is not a landscape node, so keeping
-- it out holds the index proportional to what is readable rather than to
-- everything the hour touched.
--
-- The column order matches the query exactly — equality on `(window_start,
-- window_size)`, then the sort — so the ORDER BY is satisfied by the scan.

CREATE INDEX IF NOT EXISTS "aggregation_windows_active_idx"
  ON "aggregation_windows" ("window_start", "window_size", "event_count" DESC, "item_id")
  WHERE "event_count" > 0;
