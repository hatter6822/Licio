-- WS-D.1.5 — a spent recovery code can COMPLETE the verification it was spent
-- for, so the last one cannot lock an account out.
--
-- Granting the session flag is a Redis write and cannot join this transaction,
-- so it runs after the commit — which is right, because the reverse grants
-- steward authority before anything records it.  What that leaves is the case
-- the ordering cannot fix on its own: the unit commits (code consumed,
-- `mfa_verify` written), the Redis grant then fails, and the request answers
-- 500 with an unverified session.  On any code but the last that costs a retry
-- with another code.  On the LAST one it costs the account, permanently, for a
-- fault on our side.
--
-- Recording WHICH session a code was spent for makes the operation resumable:
-- a retry presenting that same code, from that same session, re-attempts the
-- grant instead of being told the code is invalid.  Single-use is unchanged —
-- the code still grants MFA to exactly one session, and a holder presenting it
-- from any other session gets nothing.
--
-- Nullable: every code issued before this column existed has no pending
-- verification, which is exactly what NULL says.
ALTER TABLE "mfa_recovery_codes" ADD COLUMN IF NOT EXISTS "verification_session_hash" text;

-- The resume lookup is (user, code_hash) — the same shape the consume uses.
CREATE INDEX IF NOT EXISTS "mfa_recovery_pending_idx"
  ON "mfa_recovery_codes" ("user_id", "code_hash")
  WHERE "verification_session_hash" IS NOT NULL;
