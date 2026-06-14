-- WS-Q.2.3c — extend the upload content-type allowlist with the two video
-- containers and raise the byte ceiling to 200 MB (the per-type cap is enforced
-- at the API layer via ingestion.video_max_bytes). The CHECK is replaced via
-- DROP + ADD NOT VALID then VALIDATE so an existing large table is not fully
-- locked (the validation scan takes only SHARE UPDATE EXCLUSIVE).
ALTER TABLE "uploads" DROP CONSTRAINT "uploads_content_type_allowed";--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_content_type_allowed" CHECK ("uploads"."content_type" in ('image/jpeg','image/png','image/webp','image/avif','application/pdf','video/mp4','video/webm')) NOT VALID;--> statement-breakpoint
ALTER TABLE "uploads" VALIDATE CONSTRAINT "uploads_content_type_allowed";--> statement-breakpoint
ALTER TABLE "uploads" DROP CONSTRAINT "uploads_byte_size_range";--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_byte_size_range" CHECK ("uploads"."byte_size" between 1 and 209715200) NOT VALID;--> statement-breakpoint
ALTER TABLE "uploads" VALIDATE CONSTRAINT "uploads_byte_size_range";
