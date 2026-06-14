-- WS-Q.1.2 — rooms: binary visibility + the two orthogonal §16.2 axes.
--
-- Behavior-preserving migration (the @licio/shared mapLegacyRoomVisibility
-- SSOT, mirrored row-for-row). The axes are derived from the legacy
-- three-value visibility BEFORE that value is collapsed — this ordering is
-- mandatory: collapsing the enum first would erase the `expert_led`
-- distinction and silently widen those rooms' top-level posting to
-- `all_members`.
--
-- Transaction-safety note: drizzle's migrate() runs the whole chain in ONE
-- transaction. The rooms table is bounded by room count, so the enum
-- recreation + backfill is cheap and a single txn is safe (the 0008 precedent).
CREATE TYPE "public"."room_join_model" AS ENUM('open', 'request_approval', 'invite');--> statement-breakpoint
CREATE TYPE "public"."room_posting_policy" AS ENUM('all_members', 'experts_and_stewards');--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "join_model" "room_join_model";--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "posting_policy" "room_posting_policy";--> statement-breakpoint
-- (1) Backfill the axes from the STILL-THREE-VALUE visibility (the only step
--     that can still distinguish expert_led — it MUST precede the enum change).
UPDATE "rooms" SET
  "join_model" = (CASE "visibility"::text
    WHEN 'public' THEN 'open'
    WHEN 'restricted' THEN 'request_approval'
    WHEN 'expert_led' THEN 'request_approval'
    ELSE 'open' END)::"room_join_model",
  "posting_policy" = (CASE "visibility"::text
    WHEN 'expert_led' THEN 'experts_and_stewards'
    ELSE 'all_members' END)::"room_posting_policy";--> statement-breakpoint
-- (2) Recreate the visibility enum (restricted|expert_led -> private). The
--     DEFAULT must be dropped before ALTER TYPE and re-added afterwards.
ALTER TABLE "rooms" ALTER COLUMN "visibility" DROP DEFAULT;--> statement-breakpoint
CREATE TYPE "public"."room_visibility_v2" AS ENUM('public', 'private');--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "visibility" TYPE "public"."room_visibility_v2" USING (CASE "visibility"::text WHEN 'restricted' THEN 'private' WHEN 'expert_led' THEN 'private' ELSE "visibility"::text END)::"public"."room_visibility_v2";--> statement-breakpoint
DROP TYPE "public"."room_visibility";--> statement-breakpoint
ALTER TYPE "public"."room_visibility_v2" RENAME TO "room_visibility";--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "visibility" SET DEFAULT 'public';--> statement-breakpoint
-- (3) Defaults + NOT NULL on the two axes, then the coherence CHECKs.
ALTER TABLE "rooms" ALTER COLUMN "join_model" SET DEFAULT 'open';--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "posting_policy" SET DEFAULT 'all_members';--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "join_model" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "posting_policy" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_public_join_open" CHECK ("rooms"."visibility" = 'private' OR "rooms"."join_model" = 'open');--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_steward_private" CHECK ("rooms"."room_type" <> 'steward' OR "rooms"."visibility" = 'private');
