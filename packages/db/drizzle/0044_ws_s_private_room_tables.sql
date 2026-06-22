-- WS-S.1.2 — the two (and ONLY) server tables a Private P2P room may touch
-- (PRIVATE_SPEC §8.2/§15.3/§23.2).  The §8.1 forbiddance list is the column
-- DENYLIST: no content/CID/op-head/story-thread-contribution-id/title/body/
-- media/manifest/search/embedding/topic/url/content-event/ranking/attention/
-- member-list/member-count/activity/unread/push/key/invite/recovery column
-- exists here (the `check:private-rendezvous-schema` gate + the column-allowlist
-- unit test pin it).  The stub holds only §8.2 commitments + bootstrap policy +
-- listed-room display metadata; the rendezvous record holds only blind ids +
-- ciphertext + a TTL, with NO foreign key to `rooms` (it must be un-linkable to
-- any room — §15.3.1).
CREATE TYPE "public"."private_rendezvous_policy" AS ENUM('licio_blind', 'member_rendezvous', 'manual_only');--> statement-breakpoint
CREATE TABLE "private_rendezvous_records" (
	"rendezvous_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_blind_id" text NOT NULL,
	"peer_blind_id" text NOT NULL,
	"encrypted_announcement" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "private_room_stubs" (
	"stub_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_server_id" uuid NOT NULL,
	"directory_mode" "room_directory_mode" NOT NULL,
	"display_name" text,
	"display_description" text,
	"display_avatar_public_cid" text,
	"room_public_key" text NOT NULL,
	"manifest_key_commitment" text NOT NULL,
	"latest_manifest_commitment" text,
	"rendezvous_policy" "private_rendezvous_policy" NOT NULL,
	"bootstrap_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signed_stub" jsonb NOT NULL,
	"stub_signature" text NOT NULL,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_room_stubs_not_detached" CHECK ("private_room_stubs"."directory_mode" <> 'detached'),
	CONSTRAINT "private_room_stubs_listed_display_only" CHECK ("private_room_stubs"."directory_mode" = 'listed' OR ("private_room_stubs"."display_name" IS NULL AND "private_room_stubs"."display_description" IS NULL AND "private_room_stubs"."display_avatar_public_cid" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "private_room_stubs" ADD CONSTRAINT "private_room_stubs_room_server_id_rooms_room_id_fk" FOREIGN KEY ("room_server_id") REFERENCES "public"."rooms"("room_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_room_stubs" ADD CONSTRAINT "private_room_stubs_created_by_account_id_users_user_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "private_rendezvous_room_blind_idx" ON "private_rendezvous_records" USING btree ("room_blind_id");--> statement-breakpoint
CREATE INDEX "private_rendezvous_expires_idx" ON "private_rendezvous_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "private_room_stubs_room_idx" ON "private_room_stubs" USING btree ("room_server_id");