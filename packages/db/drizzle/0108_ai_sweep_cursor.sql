-- WS-K.1.4a — make the summary sweep's position SURVIVE the process holding it.
--
-- The cursor that pages the sweep past already-examined threads was
-- process-local, and the tick runs under a distributed lease: a restart, a
-- deploy, or a different pod winning the lease resets it to the newest page.
-- At 50 threads an hour a large installation is reset long before it reaches
-- the tail, so the older threads it exists to summarize are never reached —
-- the same permanent gap the cursor was added to close, one layer up.
--
-- A composite cursor, because the sweep's order is `(created_at, thread_id)`:
-- a bare timestamp cannot break a tie, and a tie that resolves the wrong way
-- either skips a thread or loops on one.
CREATE TABLE IF NOT EXISTS "ai_sweep_cursors" (
  "sweep_name" text PRIMARY KEY NOT NULL,
  "cursor_created_at" timestamp with time zone,
  "cursor_ref" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
