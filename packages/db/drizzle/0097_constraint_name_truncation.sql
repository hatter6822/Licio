-- Rename the five foreign keys whose DERIVED names exceed Postgres's 63-byte
-- identifier limit (SPEC §6.12 schema hygiene).
--
-- Postgres does not reject an over-long identifier — it TRUNCATES it to 63
-- bytes and emits only a NOTICE.  Five Drizzle-derived constraint names were
-- landing truncated on every fresh migration:
--
--   73  debate_arenas_challenger_contribution_id_contributions_contribution_id_fk
--   69  debate_arenas_target_contribution_id_contributions_contribution_id_fk
--   67  steward_governance_vote_election_id_steward_election_election_id_fk
--   65  room_governance_prompt_model_id_room_governance_model_model_id_fk
--   64  room_agent_binding_prompt_id_room_governance_prompt_prompt_id_fk
--
-- No two of them collided, so nothing was broken — but the failure mode they
-- were one name away from is silent and bad: two DIFFERENT intended names that
-- agree on their first 63 bytes truncate to the SAME stored name, and then a
-- CREATE fails with a duplicate-constraint error at migrate time, or worse a
-- later `DROP CONSTRAINT` / `ALTER ... RENAME` targets whichever one won the
-- race.  Both `debate_arenas_*` entries above differ only after byte 22, and
-- the two `room_governance_*`/`room_agent_binding_*` families share long
-- prefixes, so the margin was thin.
--
-- Fix, in three parts: the schema now declares these five with EXPLICIT short
-- names (table-level `foreignKey({ name })` — Drizzle's inline `.references()`
-- cannot name a constraint), this migration renames what already exists, and
-- `pnpm check:sql-identifiers` fails CI on any future identifier over the
-- limit so the class cannot come back.
--
-- FORWARD-ONLY and IDEMPOTENT.  The historical migrations that created these
-- constraints are immutable applied history and are NOT edited; a fresh
-- database replays them (Postgres truncates exactly as before) and then lands
-- here.  Each rename is guarded on the truncated name still being present, so
-- this is a no-op on a database that has already been renamed — and the guard
-- also covers the boundary case where a future Postgres raised the limit and
-- the untruncated name is what actually exists.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      -- (schema, table, current 63-byte truncated name, new short name)
      ('public',   'debate_arenas',
       'debate_arenas_challenger_contribution_id_contributions_contribu',
       'debate_arenas_challenger_contribution_fk'),
      ('public',   'debate_arenas',
       'debate_arenas_target_contribution_id_contributions_contribution',
       'debate_arenas_target_contribution_fk'),
      ('knomosis', 'steward_governance_vote',
       'steward_governance_vote_election_id_steward_election_election_i',
       'steward_governance_vote_election_fk'),
      ('knomosis', 'room_governance_prompt',
       'room_governance_prompt_model_id_room_governance_model_model_id_',
       'room_governance_prompt_model_fk'),
      ('knomosis', 'room_agent_binding',
       'room_agent_binding_prompt_id_room_governance_prompt_prompt_id_f',
       'room_agent_binding_prompt_fk')
    ) AS t(schema_name, table_name, old_name, new_name)
  LOOP
    -- Rename only when the OLD name is present and the NEW one is not: this
    -- makes the migration safe to re-run and safe on a database provisioned
    -- from the already-corrected schema.
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = target.schema_name
         AND r.relname = target.table_name
         AND c.conname = target.old_name
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = target.schema_name
         AND r.relname = target.table_name
         AND c.conname = target.new_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I',
        target.schema_name, target.table_name, target.old_name, target.new_name
      );
    END IF;
  END LOOP;
END $$;
