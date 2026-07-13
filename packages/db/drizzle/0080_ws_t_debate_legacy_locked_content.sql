-- WS-T — backfill the locked snapshot for LEGACY judged/resolved arenas
-- (rows that reached their verdict before the live-window redesign added
-- `locked_content` in 0079, so the column is NULL for them).
--
-- Why: the arena projection falls back to the LIVE contribution/story rows
-- whenever the snapshot is absent, and a judged arena's authors may edit
-- freely during the 24h override window — so without this backfill a steward
-- weighing an override (or any later viewer of a legacy verdict) could be
-- shown post-verdict text instead of the material the adjudicator actually
-- judged.  The snapshot is built from the rows AS OF THIS MIGRATION — the
-- closest available approximation of the judged material — under the SAME
-- suppression doctrine as the runtime snapshot (`snapshotDebateContent`):
-- a moderation-withheld comment or a hidden story contributes an EMPTY side,
-- never withheld text.  `locked_at` is stamped from `verdict_at` (the instant
-- the legacy material effectively froze).
--
-- NO wallet/payment/treasury/financial column appears here (SPEC §21.5/§13.6).
UPDATE "debate_arenas" SET
  "locked_at" = COALESCE("debate_arenas"."locked_at", "debate_arenas"."verdict_at"),
  "locked_content" = jsonb_build_object(
    'target', CASE
      WHEN "debate_arenas"."target_type" = 'comment' THEN COALESCE((
        SELECT CASE WHEN c."moderation_state" = 'published' THEN jsonb_build_object(
          'title', NULL,
          'body', c."body",
          'citations', c."citations",
          'updatedAt', to_char(c."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) ELSE NULL END
        FROM "contributions" c
        WHERE c."contribution_id" = "debate_arenas"."target_contribution_id"
      ), '{"title": null, "body": "", "citations": [], "updatedAt": null}'::jsonb)
      ELSE COALESCE((
        SELECT CASE WHEN s."hidden_state" IS NULL THEN jsonb_build_object(
          'title', s."title",
          'body', CASE WHEN s."submission_metadata"->>'submission_type' = 'original_brief'
                       THEN COALESCE(s."submission_metadata"->>'body', '')
                       ELSE COALESCE(s."excerpt", '') END,
          'citations', CASE WHEN s."canonical_url" IS NOT NULL
                            THEN jsonb_build_array(jsonb_build_object('url', s."canonical_url"))
                            ELSE '[]'::jsonb END,
          'updatedAt', to_char(s."last_material_update_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) ELSE NULL END
        FROM "stories" s
        WHERE s."story_id" = "debate_arenas"."story_id"
      ), '{"title": null, "body": "", "citations": [], "updatedAt": null}'::jsonb)
    END,
    'correction', COALESCE((
      SELECT CASE WHEN c."moderation_state" = 'published' THEN jsonb_build_object(
        'title', NULL,
        'body', c."body",
        'citations', c."citations",
        'updatedAt', to_char(c."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ELSE NULL END
      FROM "contributions" c
      WHERE c."contribution_id" = "debate_arenas"."challenger_contribution_id"
    ), '{"title": null, "body": "", "citations": [], "updatedAt": null}'::jsonb)
  )
WHERE "debate_arenas"."state" IN ('judged', 'resolved')
  AND "debate_arenas"."locked_content" IS NULL;
