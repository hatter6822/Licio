-- WS-T.2.3 — GIFs are first-class comment media. The existing byte-size CHECK
-- already admits MAX_GIF_BYTES (8 MiB) under the 200 MiB hard ceiling.
ALTER TABLE "uploads" DROP CONSTRAINT "uploads_content_type_allowed";--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_content_type_allowed" CHECK ("uploads"."content_type" in ('image/jpeg','image/png','image/webp','image/avif','image/gif','application/pdf','video/mp4','video/webm','text/vtt')) NOT VALID;--> statement-breakpoint
ALTER TABLE "uploads" VALIDATE CONSTRAINT "uploads_content_type_allowed";
