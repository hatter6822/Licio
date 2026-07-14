-- WS-M.2.3b-1 (PR #144 review, wave 8): scope the governance-signature
-- uniqueness by PURPOSE.
--
-- A multisig law-pack requires designated signers to record an
-- approval/multisig co-signature before execution.  The old
-- (proposal_id, wallet_account_id) unique rejected any second signature from
-- the wallet that already cast the ballot, leaving passed proposals stuck
-- unless signers abstained or held a second wallet.  One row per
-- (proposal, wallet, purpose) keeps ballots single-use per wallet while
-- letting the execution co-signature coexist.  The one-vote-per-user and
-- single-use-nonce uniques are unchanged.
DROP INDEX IF EXISTS "knomosis"."governance_signature_unique_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "governance_signature_unique_idx"
  ON "knomosis"."governance_signature" ("proposal_id", "wallet_account_id", "purpose");
