-- Topic catalog + author-proposed topics (SPEC §14.1/§24.1). Story `topic_ids`
-- now carry only AI-VALIDATED catalog topics; the author's raw picks land in a
-- new UNTRUSTED `proposed_topic_ids` column that the WS-K validator confirms
-- against the content on `content.normalized`. Existing rows default their new
-- `proposed_topic_ids` to the empty array (they predate author proposals).
ALTER TABLE "stories" ADD COLUMN "proposed_topic_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
--> statement-breakpoint
-- Backfill (expand→backfill→contract): the pre-catalog composer stored a
-- per-story RANDOM uuid in `topic_ids`, which is not a real catalog topic. Reset
-- any row whose `topic_ids` are not ALL catalog topics (incl. the UNCLASSIFIED
-- sentinel) to the sentinel, so a legacy random id can never reach the feed /
-- story wire / PHI / invariant grouping as if it were a trusted topic; those
-- rows carry no trusted topic until the WS-K validator reclassifies them from
-- content. Rows already holding only catalog topics are untouched, and
-- `topic_ids` stays NON-EMPTY (the sentinel satisfies the cardinality CHECK).
UPDATE "stories"
SET "topic_ids" = ARRAY['70b1c0de-0000-4000-8000-000000000000']::uuid[]
WHERE NOT ("topic_ids" <@ ARRAY[
  '70b1c0de-0000-4000-8000-000000000000',
  '70b1c0de-0000-4000-8000-000000000001',
  '70b1c0de-0000-4000-8000-000000000002',
  '70b1c0de-0000-4000-8000-000000000003',
  '70b1c0de-0000-4000-8000-000000000004',
  '70b1c0de-0000-4000-8000-000000000005',
  '70b1c0de-0000-4000-8000-000000000006',
  '70b1c0de-0000-4000-8000-000000000007',
  '70b1c0de-0000-4000-8000-000000000008',
  '70b1c0de-0000-4000-8000-000000000009',
  '70b1c0de-0000-4000-8000-00000000000a',
  '70b1c0de-0000-4000-8000-00000000000b',
  '70b1c0de-0000-4000-8000-00000000000c',
  '70b1c0de-0000-4000-8000-00000000000d'
]::uuid[]);
--> statement-breakpoint
-- Source profiles: `sources.typical_topics` was unioned from the SAME pre-catalog
-- random placeholders by `recordObservation`, so a source can keep exposing
-- non-catalog UUIDs (via GET /v1/sources/:id) even after its stories are
-- revalidated. Keep only catalog SUBJECT topics (the sentinel is never a
-- "typical topic"), preserving order and dropping every non-catalog id. Only
-- rows that actually hold a non-subject id are rewritten.
UPDATE "sources"
SET "typical_topics" = ARRAY(
  SELECT t FROM unnest("typical_topics") AS t
  WHERE t = ANY(ARRAY[
    '70b1c0de-0000-4000-8000-000000000001',
    '70b1c0de-0000-4000-8000-000000000002',
    '70b1c0de-0000-4000-8000-000000000003',
    '70b1c0de-0000-4000-8000-000000000004',
    '70b1c0de-0000-4000-8000-000000000005',
    '70b1c0de-0000-4000-8000-000000000006',
    '70b1c0de-0000-4000-8000-000000000007',
    '70b1c0de-0000-4000-8000-000000000008',
    '70b1c0de-0000-4000-8000-000000000009',
    '70b1c0de-0000-4000-8000-00000000000a',
    '70b1c0de-0000-4000-8000-00000000000b',
    '70b1c0de-0000-4000-8000-00000000000c',
    '70b1c0de-0000-4000-8000-00000000000d'
  ]::uuid[])
)
WHERE NOT ("typical_topics" <@ ARRAY[
  '70b1c0de-0000-4000-8000-000000000001',
  '70b1c0de-0000-4000-8000-000000000002',
  '70b1c0de-0000-4000-8000-000000000003',
  '70b1c0de-0000-4000-8000-000000000004',
  '70b1c0de-0000-4000-8000-000000000005',
  '70b1c0de-0000-4000-8000-000000000006',
  '70b1c0de-0000-4000-8000-000000000007',
  '70b1c0de-0000-4000-8000-000000000008',
  '70b1c0de-0000-4000-8000-000000000009',
  '70b1c0de-0000-4000-8000-00000000000a',
  '70b1c0de-0000-4000-8000-00000000000b',
  '70b1c0de-0000-4000-8000-00000000000c',
  '70b1c0de-0000-4000-8000-00000000000d'
]::uuid[]);

