-- WS-T.6 actor reference on reply notifications (PR #131 review): a
-- notification row lives in the RECIPIENT's inbox but names the ACTOR's
-- handle, and hard deletion TOMBSTONES the users row (the FK actions here
-- never fire in production) — without an actor reference the deletion job
-- cannot find the rows to anonymize, so the erased handle would keep
-- appearing in other users' inboxes.  Nullable (nulled on actor erasure);
-- the SET NULL action is the dev/test backstop for true row deletes.
ALTER TABLE "reply_notifications" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "reply_notifications" ADD CONSTRAINT "reply_notifications_actor_user_id_users_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reply_notifications_actor_idx" ON "reply_notifications" USING btree ("actor_user_id");
