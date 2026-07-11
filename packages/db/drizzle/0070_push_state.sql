-- Durable Web Push state (WS-C.2.4a/c production parity).
--
-- Push subscriptions and notification preferences previously lived in a
-- process-local map: registrations were lost on restart/deploy and invisible
-- to sibling replicas, so a bodyless wake only reached endpoints that happened
-- to register on the same instance since its last boot.
--
-- Privacy: `session_ref` / `state_ref` are SHA-256 hashes derived by the
-- adapter — a raw session token never sits at rest.  `user_id` cascades with
-- account deletion so a purged account leaves no reachable push endpoint.
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"subscription" jsonb NOT NULL,
	"session_ref" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "push_preferences" (
	"state_ref" text PRIMARY KEY NOT NULL,
	"preferences" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
