-- WS-T.2.1 — additive enum extension for the comment-first write model.
-- PostgreSQL cannot safely drop an enum value in a down migration; the safe
-- rollback is to stop writing the value and leave the unused enum member.
ALTER TYPE "public"."contribution_type" ADD VALUE IF NOT EXISTS 'comment';
