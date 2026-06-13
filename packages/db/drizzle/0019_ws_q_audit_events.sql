-- WS-Q.1.7b — audit-event taxonomy: content/room visibility transitions.
-- Non-locking enum extension (the 0013 audit-enum-extension precedent).
-- Governance setting writes keep using `forum_config_change`; only visibility
-- transitions use these two new types.
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'story_visibility_change';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'room_visibility_change';
