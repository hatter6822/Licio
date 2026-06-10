ALTER TABLE "user_auth" ADD COLUMN "pending_email" text;--> statement-breakpoint
ALTER TABLE "user_auth" ADD COLUMN "mfa_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roles" text[] DEFAULT '{user}'::text[] NOT NULL;