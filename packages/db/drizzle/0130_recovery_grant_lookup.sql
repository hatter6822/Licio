-- WS-D.1.5 — the spent recovery code IS the MFA grant, so it is read back by
-- the session it verified.
--
-- `verification_session_hash` was added (migration 0128) as a note about a
-- verification whose Redis grant had failed, to be resumed later.  That design
-- needed the two writes to be reconciled, and no ordering of them is correct:
-- grant-then-record loses the record, record-then-grant loses the grant.  The
-- column now carries the grant itself — a session has cleared MFA if a spent
-- row names it — so the transaction that spends the code is the whole of it.
--
-- 0128's index is on `(user_id, code_hash)`, which serves the lookup that
-- design needed ("is THIS code resumable").  The lookup this one needs is the
-- other way round: "which grant, if any, names this session".  Partial, because
-- only a spent row ever carries a hash, and unique because a session is
-- verified by at most one code — the constraint is the single-use property
-- stated where the database can hold it, not merely checked in the route.
CREATE UNIQUE INDEX IF NOT EXISTS "mfa_recovery_grant_session_idx"
  ON "mfa_recovery_codes" ("verification_session_hash")
  WHERE "verification_session_hash" IS NOT NULL;

-- The resume lookup 0128 added has no reader left.
DROP INDEX IF EXISTS "mfa_recovery_pending_idx";
