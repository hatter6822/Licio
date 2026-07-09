-- WS-T — add the `validated` dispute posture (challenged & proven accurate).
--
-- A sourced correction whose debate verdict is `upheld` now tags the challenged
-- comment/story `validated` ("Validated") instead of clearing it back to `none`:
-- challenged and PROVEN ACCURATE. It carries NO ranking penalty (a positive
-- content-integrity signal, never applause — the feed dispute sink and the
-- comment-section sink fire only for `incorrect`) and remains re-challengeable if
-- new evidence emerges. Additive; existing rows are unaffected.
--
-- NO wallet/payment/treasury/financial column appears here (SPEC §21.5/§13.6):
-- the debate outcome is content-structural, never funded.
ALTER TYPE "public"."contribution_dispute_status" ADD VALUE IF NOT EXISTS 'validated';--> statement-breakpoint
ALTER TYPE "public"."story_dispute_status" ADD VALUE IF NOT EXISTS 'validated';
