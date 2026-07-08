-- WS-L.2.5a — PER-CHAIN financial wallet uniqueness.  The link identity moves
-- from `(address_hash)` to `(address_hash, chain_id)` so the SAME address may be
-- linked on multiple active chains (distinct rows), but never twice on one chain.
-- The cross-user "one address → one account" rule is enforced in the link flow
-- via a chain-agnostic ownership lookup, so this does NOT weaken account binding.
DROP INDEX "wallet"."wallet_accounts_addr_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_addr_chain_idx" ON "wallet"."wallet_accounts" USING btree ("address_hash","chain_id");
