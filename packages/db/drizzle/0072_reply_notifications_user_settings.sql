-- WS-T.6 reply notifications + WS-C settings sync — durable production
-- bindings (production-parity pass).  Both previously lived in process-local
-- maps: a restart destroyed every user's notification inbox and settings, and
-- replicas each served a different copy.  The settings map was additionally
-- keyed by a SHARED 'anonymous' fallback (a cross-user state bleed) — the new
-- binding persists per signed-in user (cross-device settings sync) or per
-- session, and never persists for a cookieless visitor.
--
-- Privacy: notification rows carry ids + actor handle only; `state_ref` is a
-- SHA-256 hash derived by the adapter (a raw session token never sits at
-- rest); `recipient_user_id` cascades with account deletion.
CREATE TABLE "reply_notifications" (
	"notification_id" uuid PRIMARY KEY NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"parent_comment_id" uuid NOT NULL,
	"actor_handle" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "reply_notifications" ADD CONSTRAINT "reply_notifications_recipient_user_id_users_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "reply_notifications_comment_idx" ON "reply_notifications" USING btree ("comment_id");
--> statement-breakpoint
CREATE INDEX "reply_notifications_recipient_idx" ON "reply_notifications" USING btree ("recipient_user_id","created_at");
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"state_ref" text PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
