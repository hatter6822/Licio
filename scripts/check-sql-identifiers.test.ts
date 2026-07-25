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
    // character-length check would wave this through, and Postgres would
    // truncate mid-sequence.
    const name = 'é'.repeat(32);
    expect(Buffer.byteLength(name, 'utf8')).toBe(64);
    expect(name.length).toBe(32);
    expect(findOverlongIdentifiers('0099_x.sql', `CREATE TABLE "${name}" ()`)).toEqual([
      { file: '0099_x.sql', identifier: name, bytes: 64 },
    ]);
  });

  // The gap Codex found on PR #169: hand-authored migrations may leave a name
  // unquoted, and unlike the quoted case the catalog can never reveal it after
  // the fact — Postgres stores only the truncated 63-byte result — so the
  // static scan is the ONLY protection against it.
  it('flags an UNQUOTED over-long name (regression)', () => {
    const name = `debate_arenas_${'x'.repeat(50)}_idx`;
    expect(Buffer.byteLength(name, 'utf8')).toBe(68);
    expect(findOverlongIdentifiers('0099_x.sql', `CREATE INDEX ${name} ON t (c);`)).toEqual([
      { file: '0099_x.sql', identifier: name, bytes: 68 },
    ]);
  });

  it('flags unquoted names in every DDL position, without enumerating them', () => {
    // Scanning every bare token is safe because only tokens OVER the limit are
    // reported and no SQL keyword comes close — so no DDL form can be missed
    // by omission from a context list.
    const name = `c_${'y'.repeat(70)}`;
    for (const stmt of [
      `ALTER TABLE t ADD CONSTRAINT ${name} CHECK (x > 0);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON t (c);`,
      `CREATE TRIGGER ${name} BEFORE INSERT ON t EXECUTE FUNCTION f();`,
      `ALTER TABLE t RENAME CONSTRAINT old_name TO ${name};`,
      `CREATE TYPE ${name} AS ENUM ('a');`,
    ]) {
      expect(findOverlongIdentifiers('0099_x.sql', stmt)).toHaveLength(1);
    }
  });

  it('does not flag long text inside string literals or comments', () => {
    // Prose and URLs legitimately run past 63 bytes; only identifiers matter.
    const long = 'z'.repeat(80);
    const sql = [
      `-- a very long note ${long}`,
      `/* block comment ${long} */`,
      `INSERT INTO t (url) VALUES ('https://example.org/${long}');`,
      `COMMENT ON TABLE t IS 'it''s a quoted apostrophe plus ${long}';`,
    ].join('\n');
    expect(findOverlongIdentifiers('0099_x.sql', sql)).toEqual([]);
  });

  it('still scans DDL inside a dollar-quoted DO block (migration 0097 shape)', () => {
    const name = `d_${'w'.repeat(70)}`;
    const sql = `DO $$ BEGIN CREATE INDEX ${name} ON t (c); END $$;`;
    expect(findOverlongIdentifiers('0097_x.sql', sql)).toHaveLength(1);
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

  // Postgres writes a literal `"` inside a quoted identifier as `""`. Stopping
  // at the first quote splits one over-long name into two sub-limit halves, and
  // both pass — so the DECODED name is what must be measured.
  it('treats "" as an escaped quote inside ONE identifier (regression)', () => {
    const decoded = `${'a'.repeat(32)}"${'b'.repeat(31)}`; // 64 bytes decoded
    expect(Buffer.byteLength(decoded, 'utf8')).toBe(64);
    const written = `${'a'.repeat(32)}""${'b'.repeat(31)}`; // as it appears in SQL
    expect(findOverlongIdentifiers('0099_x.sql', `CREATE INDEX "${written}" ON t (c);`)).toEqual([
      { file: '0099_x.sql', identifier: decoded, bytes: 64 },
    ]);
  });

  it('does not split a SHORT identifier containing an escaped quote', () => {
    const written = 'we""ird';
    expect(findOverlongIdentifiers('0099_x.sql', `CREATE INDEX "${written}" ON t (c);`)).toEqual(
      [],
    );
  });

  it('does not mistake prose or JSON paths between quotes for identifiers', () => {
    // Comments and string literals are skipped by the scanner, so a `"` inside
    // either cannot pair with a later one and report the span between them as
    // one enormous identifier.
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
