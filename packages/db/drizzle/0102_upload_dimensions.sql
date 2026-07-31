-- Intrinsic image dimensions on `uploads` (WS-C perf: reserve LCP space).
--
-- The feed and comment `<img>` elements carried no `width`/`height` and sat in
-- no aspect-ratio box, so every image resolved from zero height to its natural
-- height on load: cumulative layout shift on the largest-contentful element of
-- the page, and the reader loses their place mid-scroll.  Fixing that in the
-- renderer needs the image's REAL dimensions, which means the wire has to carry
-- them, which means they have to be stored.
--
-- They cost nothing to obtain: `apps/api/src/forum/exif.ts` already walks each
-- container's headers byte by byte to strip metadata, so `imageDimensions()`
-- reads two numbers out of bytes already in hand — no decode, no re-encode, no
-- dependency, no second pass.
--
-- NULLABLE, and deliberately so.  Three populations are legitimately unknown:
-- every upload created before this migration; video and caption uploads, which
-- have no image dimensions at all; and AVIF, whose dimensions live in an `ispe`
-- property box reached through the ISO-BMFF item-property tables — the same
-- structure the metadata stripper declines to rewrite.  The renderer treats
-- NULL as "unknown" and falls back to its unreserved behaviour, because an
-- image told the WRONG size is worse than one told no size: the layout reserves
-- the wrong box and shifts anyway, with the shift now also wrong.
--
-- The CHECK pins that the two are known together or not at all — half a
-- dimension reserves nothing and would only ever be a write bug.
ALTER TABLE "uploads" ADD COLUMN IF NOT EXISTS "image_width" integer;
--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN IF NOT EXISTS "image_height" integer;
--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_image_dimensions_ck"
  CHECK (
    ("image_width" IS NULL) = ("image_height" IS NULL)
    AND ("image_width" IS NULL OR ("image_width" > 0 AND "image_width" <= 65535))
    AND ("image_height" IS NULL OR ("image_height" > 0 AND "image_height" <= 65535))
  );
