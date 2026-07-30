-- WS-J.2.5 — a monotonic APPEND ORDINAL on the moderation audit trail.
--
-- The trail paginated on a `(event_time, audit_id)` keyset cursor, and that cursor
-- cannot be built correctly from a read row.  `event_time` is `timestamptz` —
-- MICROSECOND resolution in Postgres — while the driver hands back a JS `Date`, which
-- is MILLISECOND.  The microseconds are gone before any mapper sees the row, so the
-- encoded cursor is always <= the true position, and the next page's strict `<`
-- predicate silently SKIPS every row sharing the cursor row's millisecond with smaller
-- microseconds.  Measured against this database: five `now()` inserts produced
-- .590531, .591106, .591394, .591673, .591967 — one cursor drops three rows.  An action
-- burst is exactly the case that clusters inside one millisecond, so a busy trail
-- omits the most, and omits it invisibly.
--
-- The ordinal is a total order the reader can round-trip EXACTLY (an integer), and it
-- is the append sequence the tamper-evident chain needs to be defined over.  The
-- sequence is not gapless (a rolled-back insert burns a value) — detecting a DELETED
-- row is the hash chain's job, not the ordinal's.
ALTER TABLE "moderation_audit" ADD COLUMN "ordinal" bigint;
--> statement-breakpoint
-- Backfill in the order the rows are already served in, so existing pages keep their
-- positions.  `audit_id` breaks the (frequent) event_time tie deterministically.
WITH ordered AS (
  SELECT "audit_id", row_number() OVER (ORDER BY "event_time", "audit_id") AS n
    FROM "moderation_audit"
)
UPDATE "moderation_audit" m
   SET "ordinal" = ordered.n
  FROM ordered
 WHERE m."audit_id" = ordered."audit_id";
--> statement-breakpoint
CREATE SEQUENCE "moderation_audit_ordinal_seq" OWNED BY "moderation_audit"."ordinal";
--> statement-breakpoint
-- `is_called = false` so the NEXT nextval() returns this value itself: the first new
-- row takes max+1, never colliding with a backfilled ordinal.
SELECT setval(
  'moderation_audit_ordinal_seq',
  COALESCE((SELECT max("ordinal") FROM "moderation_audit"), 0) + 1,
  false
);
--> statement-breakpoint
ALTER TABLE "moderation_audit"
  ALTER COLUMN "ordinal" SET DEFAULT nextval('moderation_audit_ordinal_seq');
--> statement-breakpoint
ALTER TABLE "moderation_audit" ALTER COLUMN "ordinal" SET NOT NULL;
--> statement-breakpoint
-- UNIQUE, not just an index: the cursor's exactness rests on one row per ordinal, and
-- the constraint's own btree serves the DESC keyset scan (Postgres reads it backwards).
ALTER TABLE "moderation_audit" ADD CONSTRAINT "moderation_audit_ordinal_key" UNIQUE ("ordinal");
