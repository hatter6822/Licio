-- The story's media dimensions, denormalized from its upload (WS-C perf).
--
-- 0102 recorded intrinsic image dimensions on `uploads`.  The feed needs them
-- on the STORY: `feedMediaOf` projects a `StoryRecord` onto the wire shape, and
-- the feed serves a page of stories at a time, so reaching the upload row from
-- there would be one extra query per media story per request — the N+1 shape
-- this codebase treats as a defect in its own right.
--
-- Copied ONCE at submission, where the upload record is already in hand
-- (`submitStory` fetches it to check the scan state and content type), from the
-- SERVER-parsed value.  Deliberately not carried in `submission_metadata`:
-- that column holds the client's own submission body, and dimensions the client
-- could state are dimensions the client could lie about — an attacker-chosen
-- reserved box is a layout the page cannot recover from.
--
-- NULL for the same populations as `uploads`: pre-migration rows, non-image
-- media, AVIF, and any container whose header did not parse.  The renderer
-- treats NULL as unknown and reserves nothing.  Immutable in practice — a
-- story's media upload is fixed at submission — so no drift from `uploads`.
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "media_width" integer;
--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "media_height" integer;
--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_media_dimensions_ck"
  CHECK (
    ("media_width" IS NULL) = ("media_height" IS NULL)
    AND ("media_width" IS NULL OR ("media_width" > 0 AND "media_width" <= 65535))
    AND ("media_height" IS NULL OR ("media_height" > 0 AND "media_height" <= 65535))
  );
