-- WS-L.2.5a — FINALIZED unlink RELEASES the (address, chain).  The per-chain
-- uniqueness index becomes PARTIAL (WHERE unlink_state <> 'finalized'): a
-- finalized (unlinked) tombstone is retained for audit + the same-user re-link
-- cooldown, yet it no longer occupies the (address, chain) slot, so a NEW owner
-- (who proves key control via SIWE) can link the released address alongside the
-- old owner's finalized row.  The cross-user "one address → one account" rule is
-- still enforced in the link flow via the non-finalized owner check.
DROP INDEX "wallet"."wallet_accounts_addr_chain_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_addr_chain_idx" ON "wallet"."wallet_accounts" USING btree ("address_hash","chain_id") WHERE "unlink_state" <> 'finalized';
