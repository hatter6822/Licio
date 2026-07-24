// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The identifier-length gate is what stops silent Postgres name truncation from
// returning, so it is pinned in both directions: a name past the limit fails,
// and the ordinary SQL around it does not.
import { describe, expect, it } from 'vitest';
import { findOverlongIdentifiers, PG_MAX_IDENTIFIER_BYTES } from './check-sql-identifiers.js';

/** A quoted identifier of exactly `n` ASCII bytes. */
const ident = (n: number): string => `a${'b'.repeat(n - 1)}`;

describe('findOverlongIdentifiers', () => {
  it('flags an identifier past the 63-byte limit and reports its byte length', () => {
    const name = ident(PG_MAX_IDENTIFIER_BYTES + 1);
    const found = findOverlongIdentifiers('0099_x.sql', `CREATE INDEX "${name}" ON "t" ("c");`);
    expect(found).toEqual([{ file: '0099_x.sql', identifier: name, bytes: 64 }]);
  });

  it('accepts an identifier of exactly the limit (Postgres stores it whole)', () => {
    const name = ident(PG_MAX_IDENTIFIER_BYTES);
    expect(findOverlongIdentifiers('0099_x.sql', `CREATE INDEX "${name}" ON "t" ("c");`)).toEqual(
      [],
    );
  });

  it('measures BYTES, not characters — a multi-byte name truncates sooner', () => {
    // 32 two-byte characters = 64 bytes but only 32 characters: a
    // character-length check would wave this through.
    const name = 'é'.repeat(32);
    expect(Buffer.byteLength(name, 'utf8')).toBe(64);
    expect(name.length).toBe(32);
    const found = findOverlongIdentifiers('0099_x.sql', `CREATE TABLE "${name}" ()`);
    // The narrow identifier charset does not match non-ASCII, so this documents
    // the known scope of the static scan: ASCII snake_case, which is every
    // identifier this schema uses. The gated DB assertion is the backstop.
    expect(found).toEqual([]);
  });

  it('reports each distinct over-long identifier once, however often it repeats', () => {
    const name = ident(70);
    const sql = `ALTER TABLE "t" ADD CONSTRAINT "${name}" FOREIGN KEY ("c") REFERENCES "u"("d");
                 ALTER TABLE "t" DROP CONSTRAINT "${name}";`;
    expect(findOverlongIdentifiers('0099_x.sql', sql)).toHaveLength(1);
  });

  it('exempts the CLOSED set of names in already-applied, immutable migrations', () => {
    // Renamed in the live schema by migration 0097; the historical SQL that
    // created them cannot be edited without diverging from applied databases.
    const historical = [
      'debate_arenas_challenger_contribution_id_contributions_contribution_id_fk',
      'debate_arenas_target_contribution_id_contributions_contribution_id_fk',
      'steward_governance_vote_election_id_steward_election_election_id_fk',
      'room_governance_prompt_model_id_room_governance_model_model_id_fk',
      'room_agent_binding_prompt_id_room_governance_prompt_prompt_id_fk',
    ];
    for (const name of historical) {
      expect(Buffer.byteLength(name, 'utf8')).toBeGreaterThan(PG_MAX_IDENTIFIER_BYTES);
      expect(findOverlongIdentifiers('0035_x.sql', `ADD CONSTRAINT "${name}"`)).toEqual([]);
    }
  });

  it('does not mistake multi-line prose or JSON paths between quotes for identifiers', () => {
    // A permissive `"[^"]+"` matches the span between two unrelated quotes and
    // reports it as an enormous identifier — the exact false positive the
    // narrow charset exists to avoid.
    const sql = [
      '-- A comment mentioning "one thing" and then, lines later,',
      '-- another quoted "phrase" in the same file.',
      `SELECT s."body" ->> 'submission_type' AS t FROM "stories" s;`,
      `COMMENT ON TABLE "stories" IS 'a long note; see "the spec" for detail';`,
    ].join('\n');
    expect(findOverlongIdentifiers('0080_x.sql', sql)).toEqual([]);
  });

  it('passes ordinary migration SQL untouched', () => {
    const sql = `CREATE TABLE "debate_arenas" ("debate_id" uuid PRIMARY KEY);
                 CREATE INDEX "debate_arenas_story_idx" ON "debate_arenas" ("story_id");
                 ALTER TABLE "debate_arenas" ADD CONSTRAINT "debate_arenas_target_contribution_fk"
                   FOREIGN KEY ("target_contribution_id") REFERENCES "contributions"("contribution_id");`;
    expect(findOverlongIdentifiers('0097_x.sql', sql)).toEqual([]);
  });
});
