ALTER TYPE "public"."audit_event_type" ADD VALUE 'ranking_config_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'ranking_killswitch_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'ranking_decision_query';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'ranking_replay_run';