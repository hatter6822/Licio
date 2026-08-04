-- WS-H.4.2d — at most ONE open bridge request per thread, enforced by the
-- database rather than by a read taken a moment before the insert.
--
-- The route checked `openForThread()` and then inserted, which is a TOCTOU: two
-- stewards acting on the same fragile join (the Civic Map offers it to every
-- steward of the room at once, so the pair is the expected case rather than a
-- rare one) both saw no open attempt and both created a `requested` row.  The
-- damage is not the duplicate itself: the credit consumer credits the NEWEST,
-- and the older row then becomes "the open attempt" again — so a later
-- contribution credits a second time for one bridge, inflating the SCOI-2
-- participation record the whole mechanism exists to keep honest.
--
-- PARTIAL, on `status = 'requested'`: a thread accumulates any number of
-- CREDITED attempts over its life, and this must not forbid the next one.
--
-- Existing duplicates are collapsed first, keeping the NEWEST per thread — the
-- one the credit consumer would have credited, so no attempt that is in flight
-- changes hands; the older rows are exactly the ones that could be credited a
-- second time.

DELETE FROM "bridge_attempts"
  WHERE "attempt_id" IN (
    SELECT "attempt_id" FROM (
      SELECT
        "attempt_id",
        row_number() OVER (
          PARTITION BY "thread_id"
          ORDER BY "created_at" DESC, "attempt_id" DESC
        ) AS "rn"
      FROM "bridge_attempts"
      WHERE "status" = 'requested'
    ) AS "ranked"
    WHERE "ranked"."rn" > 1
  );
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "bridge_attempts_open_thread_uq"
  ON "bridge_attempts" ("thread_id")
  WHERE "status" = 'requested';
