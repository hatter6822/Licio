-- WS-K "one deployed version per model name", enforced structurally
-- (PR #131 review): deployModel demotes siblings and promotes the target in
-- separate UPDATEs with no lock, so two concurrent deploys (multi-replica
-- admin route) could both persist `deployed`.  With this partial unique
-- index the second promote fails cleanly instead; interleavings serialize to
-- a coherent single-deployed outcome.
CREATE UNIQUE INDEX "ai_model_cards_one_deployed_idx" ON "ai_model_cards" USING btree ("name") WHERE "status" = 'deployed';
