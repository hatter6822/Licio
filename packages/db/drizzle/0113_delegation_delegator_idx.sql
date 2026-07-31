-- WS-M — index the double-count guard's read.
--
-- `delegatorsAlreadyConsumed` needs every delegation granted by a set of
-- delegators in a room, ACROSS ALL STATES: a revocation that happened after the
-- delegate signed is exactly the case an active-only read used to miss, so the
-- predicate cannot be narrowed to `state = 'active'`.
--
-- Neither existing index serves that.  `delegation_active_uq` is partial on
-- `state = 'active'`, so it cannot answer a query that must see revoked rows, and
-- `delegation_delegate_idx` is keyed on the DELEGATE.  So each candidate cost a
-- sequential scan of `delegation_record` — and a verified member can grow
-- their own row count there without limit by repeatedly revoking and re-creating
-- a delegation, which made the cost attacker-controlled rather than merely
-- proportional to the ballot.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside the migration
-- transaction, and this table is small enough at current scale that the brief
-- lock is the safer trade than a half-built index the chain cannot verify.
CREATE INDEX IF NOT EXISTS "delegation_delegator_idx"
  ON "knomosis"."delegation_record" ("room_id", "delegator_user_id");
