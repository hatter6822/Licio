-- WS-S.1.1 — rooms: the three private-room axes (PRIVATE_SPEC §4.1/§23.2).
--
-- Additive + idempotent (defaulted columns, the WS-Q expand pattern): every
-- existing row stays `server`/`platform` with a NULL directory mode and no
-- stub, so no row is rewritten and the down path is a clean column/type drop.
-- The five (+1 symmetric) CHECK constraints enforce the §4.1 coherence rules
-- STRUCTURALLY — they mirror the `@licio/shared` `roomAxesSchema` superRefine
-- exactly, so the storage layer and the wire schema agree and no direct write /
-- migration / old API path can persist an incoherent P2P row (a `platform`
-- P2P room, a non-private or non-`invite` P2P room, or a server room carrying a
-- P2P stub). The `p2p ⇒ join_model = 'invite'` CHECK reuses the WS-Q
-- `join_model` column, closing the gap the shared schema rejects but a raw
-- INSERT would otherwise accept.
CREATE TYPE "public"."room_authority_model" AS ENUM('platform', 'room_keys');--> statement-breakpoint
CREATE TYPE "public"."room_directory_mode" AS ENUM('listed', 'unlisted', 'detached');--> statement-breakpoint
CREATE TYPE "public"."room_storage_mode" AS ENUM('server', 'p2p');--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "storage_mode" "room_storage_mode" DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "authority_model" "room_authority_model" DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "directory_mode" "room_directory_mode";--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "p2p_stub_id" uuid;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_storage_authority_coherence" CHECK (("rooms"."storage_mode" = 'server' AND "rooms"."authority_model" = 'platform')
          OR ("rooms"."storage_mode" = 'p2p' AND "rooms"."authority_model" = 'room_keys'));--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_p2p_requires_directory_mode" CHECK ("rooms"."storage_mode" = 'server' OR "rooms"."directory_mode" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_server_no_directory_mode" CHECK ("rooms"."storage_mode" = 'p2p' OR "rooms"."directory_mode" IS NULL);--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_p2p_visibility_private" CHECK ("rooms"."storage_mode" = 'server' OR "rooms"."visibility" = 'private');--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_p2p_join_model_invite" CHECK ("rooms"."storage_mode" = 'server' OR "rooms"."join_model" = 'invite');--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_server_has_no_stub" CHECK ("rooms"."storage_mode" = 'p2p' OR "rooms"."p2p_stub_id" IS NULL);