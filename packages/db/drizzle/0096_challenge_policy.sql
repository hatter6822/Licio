-- WS-T challenge policy (SPEC §15.4) — the settled-content threshold and the
-- per-challenger standing derivations.
--
-- `settled_at` marks a target that has accumulated the configured number of
-- adjudicated `upheld` defenses since its last material edit: it can no longer
-- be challenged (the create guard refuses `target_settled`) until a room
-- steward / platform admin unsettles it or the author materially edits it
-- (comments; stories have no author edit path today).  Kept as a SEPARATE
-- nullable column — never a new dispute-status enum value — so every existing
-- wire schema, ranking feature, search filter, and badge keeps its exact
-- vocabulary (`settled` rows still read `validated`).
--
-- The challenger-standing index serves the per-account capacity/cooldown
-- derivations (live-arena counts, adjudicated win/loss aggregates, trailing
-- withdrawal windows), all computed straight from arena rows — no mutable
-- counter tables (the moderation-reports quota pattern).
ALTER TABLE "contributions" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "debate_arenas_challenger_user_idx" ON "debate_arenas" ("challenger_user_id", "state");
