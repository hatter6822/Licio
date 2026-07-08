-- WS-L.4.1c / N2 — record WHEN a simulated proposal was claimed for execution so
-- the background recovery sweep only re-drives GENUINELY stranded (crashed) claims.
-- `claimForExecution` CAS'd `timelocked`→`executing` with no timestamp, and the
-- sweep re-drove EVERY `executing` row; if it observed a live manual execution
-- between its claim and finalize it could win the finalize CAS and mis-attribute
-- the single `execution_simulated` audit row to the null-actor scheduler instead
-- of the initiating user.  The sweep now filters on this claim age (a null claim is
-- a legacy stranded row → always recoverable), so a freshly-claimed live execution
-- is never raced.
ALTER TABLE "knomosis"."governance_proposal" ADD COLUMN "execution_claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "governance_proposal_recovery_idx" ON "knomosis"."governance_proposal" USING btree ("execution_state","execution_claimed_at");
