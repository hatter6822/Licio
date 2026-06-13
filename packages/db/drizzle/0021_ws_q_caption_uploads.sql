-- WS-Q.5.2c — admit WebVTT caption tracks (text/vtt) for video posts. The
-- CHECK is replaced via DROP + ADD NOT VALID then VALIDATE so an existing large
-- table is not fully locked (the validation scan takes only SHARE UPDATE
-- EXCLUSIVE). The shared upload allowlist (forum-api.ts) mirrors this exactly
-- (parity-tested).
ALTER TABLE "uploads" DROP CONSTRAINT "uploads_content_type_allowed";--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_content_type_allowed" CHECK ("uploads"."content_type" in ('image/jpeg','image/png','image/webp','image/avif','application/pdf','video/mp4','video/webm','text/vtt')) NOT VALID;--> statement-breakpoint
ALTER TABLE "uploads" VALIDATE CONSTRAINT "uploads_content_type_allowed";
