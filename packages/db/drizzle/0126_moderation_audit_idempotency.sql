-- WS-J.2.5 — an audit row that must be written AT MOST ONCE says so, and the
-- database is what enforces it.
--
-- The §21 listing-evidence capture is "one per case": §21.3 lets a room's
-- members edit the published text, so a second snapshot attached to the same
-- case carries words the reporter never saw, labelled as what they reported.
-- The route enforced that by READING the case's trail and then appending —
-- which two distinct reports joining the same open case both pass before either
-- writes.  A check cannot fix a check.
--
-- `idempotency_key` is a general mechanism rather than a rule about one action:
-- any caller whose row must not repeat supplies a key (here
-- `listing-evidence:<case_id>`), and the partial unique index decides.  NULL —
-- the ordinary case, every other audit row — is unconstrained, and Postgres
-- does not index those at all.
--
-- Append-only is untouched: this adds a column and an index, never an update
-- path, and the row-mutation trigger still refuses everything but the
-- right-to-erasure NULLing of the user-reference columns.

ALTER TABLE "moderation_audit"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "moderation_audit_idempotency_uq"
  ON "moderation_audit" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
