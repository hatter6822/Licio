// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Postgres's identifier limit, and the CLOSED set of names already applied over
// it (SPEC §6.12 schema hygiene).
//
// Two checks enforce the limit and they share this file so neither can drift
// from the other:
//
//   • `pnpm check:sql-identifiers` reads the migration SQL with the real
//     Postgres parser — fast, needs no database, and catches a name before it
//     is ever applied.
//   • the migration harness listens for Postgres's own
//     `identifier … will be truncated` NOTICE while applying the whole chain.
//     That is authoritative and covers what no static read can: a name DERIVED
//     by Drizzle, and one composed at runtime inside `EXECUTE format(…)`.
//
// Both need the same exemptions, because the truncation below is real and
// deliberate.

/** Postgres `NAMEDATALEN - 1`: the longest identifier stored without truncation. */
export const PG_MAX_IDENTIFIER_BYTES = 63;

/** The migration that renamed the five over-long constraints to short names. */
export const RENAME_MIGRATION = '0097_constraint_name_truncation';

/**
 * Identifiers over the limit in migrations that have ALREADY been applied.
 *
 * Editing applied history is the failure this whole area exists to prevent, so
 * the five names below stay as written and `0097` renames what they created.
 * A fresh migrate therefore still creates them truncated and then renames them:
 * the end state is correct, and Postgres reports the transient truncation on
 * the way there, which is why the harness needs this list too.
 *
 * Each name is scoped to the migrations it may appear in, so reusing one in a
 * NEW migration is still a failure.
 *
 * This list is CLOSED.  Do not add to it: a new over-long identifier is a bug
 * to fix in the migration being written, not a precedent to extend.
 */
export const HISTORICAL_EXEMPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'debate_arenas_challenger_contribution_id_contributions_contribution_id_fk',
    new Set(['0056_ws_t_debate_arena', RENAME_MIGRATION]),
  ],
  [
    'debate_arenas_target_contribution_id_contributions_contribution_id_fk',
    new Set(['0056_ws_t_debate_arena', RENAME_MIGRATION]),
  ],
  [
    'steward_governance_vote_election_id_steward_election_election_id_fk',
    new Set(['0035_ws_u_ai_governed_rooms', RENAME_MIGRATION]),
  ],
  [
    'room_governance_prompt_model_id_room_governance_model_model_id_fk',
    new Set(['0035_ws_u_ai_governed_rooms', RENAME_MIGRATION]),
  ],
  [
    'room_agent_binding_prompt_id_room_governance_prompt_prompt_id_fk',
    new Set(['0035_ws_u_ai_governed_rooms', RENAME_MIGRATION]),
  ],
]);

/** A migration tag with any `.sql` suffix removed, so both callers agree. */
export function migrationTag(file: string): string {
  return file.replace(/\.sql$/, '');
}

/**
 * Whether this identifier is applied history in this migration.
 *
 * Matches the INTENDED name and the name Postgres stored for it, because the
 * two checks see different halves of the same event: the harness reads the
 * intended name out of Postgres's notice, while the static gate reads the
 * migration through the server's own parser, which has ALREADY truncated it.
 * One list, two views — keying on only one of them exempted only one check.
 */
export function isHistoricallyExempt(identifier: string, file: string): boolean {
  const tag = migrationTag(file);
  for (const [intended, migrations] of HISTORICAL_EXEMPTIONS) {
    if (!migrations.has(tag)) continue;
    if (identifier === intended) return true;
    if (identifier === truncated(intended)) return true;
  }
  return false;
}

/** What Postgres stores for an over-long name: clipped to a CHARACTER boundary. */
export function truncated(identifier: string): string {
  const bytes = Buffer.from(identifier, 'utf8');
  if (bytes.length <= PG_MAX_IDENTIFIER_BYTES) return identifier;
  // `toString` on a slice that splits a sequence yields U+FFFD; dropping any
  // trailing replacement character is the same clip Postgres performs.
  return bytes
    .subarray(0, PG_MAX_IDENTIFIER_BYTES)
    .toString('utf8')
    .replace(/\uFFFD+$/, '');
}
