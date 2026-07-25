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

  it('scans a dollar-quoted FUNCTION body too (`AS $$ … $$`)', () => {
    const name = `q_${'w'.repeat(70)}`;
    const sql = `CREATE FUNCTION f() RETURNS void AS $$ BEGIN CREATE INDEX ${name} ON t (c); END $$ LANGUAGE plpgsql;`;
    expect(findOverlongIdentifiers('0100_x.sql', sql)).toHaveLength(1);
  });

  // Round 6: dollar quoting is context-dependent. Outside `DO`/`AS` it is an
  // ordinary string literal, and tokenising one as SQL reported the prose
  // inside it as an over-long identifier — failing a perfectly valid
  // migration, since a mandatory CI gate that rejects correct input is worse
  // than no gate at all.
  it('does not flag long prose inside a dollar-quoted VALUE literal (regression)', () => {
    const word = 'z'.repeat(80);
    const sql = [
      `INSERT INTO notes (body) VALUES ($$${word}$$);`,
      `INSERT INTO notes (body) VALUES ($tag$${word}$tag$);`,
      `COMMENT ON TABLE t IS $$a note with 'quotes' and ${word}$$;`,
    ].join('\n');
    expect(findOverlongIdentifiers('0100_x.sql', sql)).toEqual([]);
  });

  // Round 7: `DO` takes an optional language clause, which puts `plpgsql` next
  // to the delimiter. An adjacency-only check read the body as DATA and skipped
  // it whole — the gate going BLIND to real DDL, which is the dangerous
  // direction: a truncated name reaches Postgres with the gate still green.
  it('scans a DO body written with an explicit LANGUAGE clause (regression)', () => {
    const name = `d_${'w'.repeat(70)}`;
    expect(
      findOverlongIdentifiers(
        '0100_x.sql',
        `DO LANGUAGE plpgsql $$ BEGIN CREATE INDEX ${name} ON t (c); END $$;`,
      ),
    ).toHaveLength(1);
  });

  // Round 7: a dollar-quote TAG follows unquoted-identifier rules, so it may
  // carry digits after the first character. A letters-only class did not
  // recognise `$q1$` as a delimiter at all, so the prose between the two
  // delimiters was tokenised as SQL and reported.
  it('accepts digits in a dollar-quote tag (regression)', () => {
    const word = 'z'.repeat(80);
    for (const tag of ['$q1$', '$version_2$']) {
      expect(
        findOverlongIdentifiers('0100_x.sql', `INSERT INTO t (b) VALUES (${tag}${word}${tag});`),
      ).toEqual([]);
    }
  });

  // Round 7: PL/pgSQL's `EXECUTE` runs its argument as SQL, so an over-long
  // name inside that string truncates exactly like one written out — but the
  // literal was being discarded as data, leaving the gate blind to it.
  describe('EXECUTE dynamic SQL inside a procedural body', () => {
    const name = `x_${'w'.repeat(70)}`;

    it('scans a string-literal EXECUTE argument (regression)', () => {
      expect(
        findOverlongIdentifiers(
          '0100_x.sql',
          `DO $$ BEGIN EXECUTE 'CREATE INDEX ${name} ON t (c)'; END $$;`,
        ),
      ).toHaveLength(1);
    });

    it('scans a dollar-quoted EXECUTE argument', () => {
      // The form used precisely when the dynamic statement itself contains
      // quotes, so it cannot be the one left unscanned.
      expect(
        findOverlongIdentifiers(
          '0100_x.sql',
          `DO $$ BEGIN EXECUTE $x$CREATE INDEX ${name} ON t (c)$x$; END $$;`,
        ),
      ).toHaveLength(1);
    });

    it('decodes the doubled-quote escape before scanning', () => {
      expect(
        findOverlongIdentifiers(
          '0100_x.sql',
          `DO $$ BEGIN EXECUTE 'CREATE INDEX "${name}" ON t (c)'; END $$;`,
        ),
      ).toHaveLength(1);
    });

    // Round-8: `E'…'` is a valid escape-string literal, and its `E` prefix
    // tokenised as a bare identifier — displacing `execute` from the history,
    // so the dynamic DDL inside read as ordinary data and went unscanned.
    it("scans an EXECUTE with an E'…' escape-string argument (regression)", () => {
      for (const prefix of ['E', 'e']) {
        expect(
          findOverlongIdentifiers(
            '0100_x.sql',
            `DO $$ BEGIN EXECUTE ${prefix}'CREATE INDEX ${name} ON t (c)'; END $$;`,
          ),
        ).toHaveLength(1);
      }
    });

    it("leaves an ordinary E'…' data literal alone", () => {
      expect(
        findOverlongIdentifiers('0100_x.sql', `INSERT INTO t (b) VALUES (E'${'z'.repeat(80)}');`),
      ).toEqual([]);
    });

    it('leaves an ORDINARY string literal as data', () => {
      // The widening must not turn every quoted string back into SQL.
      expect(
        findOverlongIdentifiers('0100_x.sql', `INSERT INTO t (b) VALUES ('${'z'.repeat(80)}');`),
      ).toEqual([]);
    });

    it('passes an EXECUTE whose statement is within the limit', () => {
      expect(
        findOverlongIdentifiers(
          '0100_x.sql',
          `DO $$ BEGIN EXECUTE 'CREATE INDEX ok_idx ON t (c)'; END $$;`,
        ),
      ).toEqual([]);
    });
  });

  it('treats a nested dollar-quoted literal inside a DO block as data', () => {
    // The body is procedural, but a value literal WITHIN it is still a string.
    const word = 'z'.repeat(80);
    const name = `d_${'w'.repeat(70)}`;
    const sql = `DO $$ BEGIN INSERT INTO notes (body) VALUES ($x$${word}$x$); CREATE INDEX ${name} ON t (c); END $$;`;
    expect(findOverlongIdentifiers('0100_x.sql', sql)).toEqual([
      { file: '0100_x.sql', identifier: name, bytes: Buffer.byteLength(name, 'utf8') },
    ]);
  });

  it('reports each distinct over-long identifier once, however often it repeats', () => {
    const name = ident(70);
    const sql = `ALTER TABLE "t" ADD CONSTRAINT "${name}" FOREIGN KEY ("c") REFERENCES "u"("d");
                 ALTER TABLE "t" DROP CONSTRAINT "${name}";`;
    expect(findOverlongIdentifiers('0099_x.sql', sql)).toHaveLength(1);
  });

  // Each exemption is keyed to the migration that actually contains it: the
  // file that created the name, plus 0097 (which must spell the old name to
  // rename it).
  const HISTORICAL: ReadonlyArray<[string, string]> = [
    [
      'debate_arenas_challenger_contribution_id_contributions_contribution_id_fk',
      '0056_ws_t_debate_arena.sql',
    ],
    [
      'debate_arenas_target_contribution_id_contributions_contribution_id_fk',
      '0056_ws_t_debate_arena.sql',
    ],
    [
      'steward_governance_vote_election_id_steward_election_election_id_fk',
      '0035_ws_u_ai_governed_rooms.sql',
    ],
    [
      'room_governance_prompt_model_id_room_governance_model_model_id_fk',
      '0035_ws_u_ai_governed_rooms.sql',
    ],
    [
      'room_agent_binding_prompt_id_room_governance_prompt_prompt_id_fk',
      '0035_ws_u_ai_governed_rooms.sql',
    ],
  ];

  it('exempts the CLOSED set of names in already-applied, immutable migrations', () => {
    // Renamed in the live schema by migration 0097; the historical SQL that
    // created them cannot be edited without diverging from applied databases.
    for (const [name, origin] of HISTORICAL) {
      expect(Buffer.byteLength(name, 'utf8')).toBeGreaterThan(PG_MAX_IDENTIFIER_BYTES);
      expect(findOverlongIdentifiers(origin, `ADD CONSTRAINT "${name}"`)).toEqual([]);
      // 0097 spells every one of them to perform the rename.
      expect(
        findOverlongIdentifiers('0097_constraint_name_truncation.sql', `RENAME "${name}" TO "x"`),
      ).toEqual([]);
    }
  });

  // The gap Codex found in round 6: a name-only exemption is a permanent
  // licence to reuse these five names. A NEW migration spelling one would
  // inherit the pass and be truncated exactly as before — the very defect the
  // gate exists to catch. Immutable history justifies exempting the files that
  // already contain the name, not files not yet written.
  it('does NOT exempt an exempted name reused in a NEW migration (regression)', () => {
    for (const [name] of HISTORICAL) {
      expect(findOverlongIdentifiers('0100_future.sql', `CREATE INDEX ${name} ON t (c);`)).toEqual([
        { file: '0100_future.sql', identifier: name, bytes: Buffer.byteLength(name, 'utf8') },
      ]);
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

  it('flags a NON-ASCII unquoted identifier (regression)', () => {
    // Postgres accepts any high-bit character as a letter in a bare identifier,
    // so this is ONE 64-byte name the server truncates — an ASCII-only token
    // class skipped the leading `é` and measured only the shorter suffix.
    const name = `é${'a'.repeat(62)}`;
    expect(Buffer.byteLength(name, 'utf8')).toBe(64);
    expect(findOverlongIdentifiers('0099_x.sql', `CREATE INDEX ${name} ON t (c);`)).toEqual([
      { file: '0099_x.sql', identifier: name, bytes: 64 },
    ]);
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

  // Round 7: Postgres stores the DECODED name of a `U&"…"` identifier, so
  // measuring the escape notation over-counts by up to 6x and would reject a
  // migration whose real identifier is far inside the limit.
  describe('U&"…" Unicode-escaped identifiers', () => {
    it('measures the DECODED name, not the escape notation (regression)', () => {
      const written = '\\0061'.repeat(13); // 65 bytes as written, 13 decoded
      expect(Buffer.byteLength(written, 'utf8')).toBeGreaterThan(PG_MAX_IDENTIFIER_BYTES);
      expect(findOverlongIdentifiers('0100_x.sql', `CREATE TABLE U&"${written}" ();`)).toEqual([]);
    });

    it('honours a UESCAPE clause that redefines the escape character', () => {
      const written = '!0061'.repeat(13);
      expect(
        findOverlongIdentifiers('0100_x.sql', `CREATE TABLE U&"${written}" UESCAPE '!' ();`),
      ).toEqual([]);
    });

    // The positive control: without it the two cases above would also pass if
    // the decoder silently produced an empty string — which is exactly the bug
    // the first cut of this had.
    it('still flags a U&"…" name that is over the limit once decoded', () => {
      const found = findOverlongIdentifiers(
        '0100_x.sql',
        `CREATE TABLE U&"${'\\0061'.repeat(64)}" ();`,
      );
      expect(found).toEqual([{ file: '0100_x.sql', identifier: 'a'.repeat(64), bytes: 64 }]);
    });

    it('decodes the 6-hex `\\+XXXXXX` form and a doubled escape', () => {
      // `\+000061` is one `a`; `\\` is one literal backslash.
      const found = findOverlongIdentifiers('0100_x.sql', `CREATE TABLE U&"\\+000061\\\\" ();`);
      expect(found).toEqual([]);
    });

    it('lowercase `u&"…"` is the same syntax', () => {
      expect(
        findOverlongIdentifiers('0100_x.sql', `CREATE TABLE u&"${'\\0061'.repeat(13)}" ();`),
      ).toEqual([]);
      expect(
        findOverlongIdentifiers('0100_x.sql', `CREATE TABLE u&"${'\\0061'.repeat(64)}" ();`),
      ).toHaveLength(1);
    });
  });

  // Round 11: three more forms Postgres accepts.
  describe('further procedural and data spellings', () => {
    const name = `q_${'w'.repeat(70)}`;

    it("scans a single-quoted DO body (`DO 'BEGIN … END'`)", () => {
      expect(
        findOverlongIdentifiers('0100_x.sql', `DO 'BEGIN CREATE TABLE ${name} (id int); END';`),
      ).toHaveLength(1);
    });

    it("honours a backslash-escaped quote inside an E'…' EXECUTE argument", () => {
      // `\'` is an apostrophe INSIDE the literal, not its terminator; ending
      // the scan there truncated the statement and hid what followed.
      const sql = `DO $$ BEGIN EXECUTE E'CREATE VIEW v AS SELECT \\'x\\' AS ${name}'; END $$;`;
      expect(findOverlongIdentifiers('0100_x.sql', sql)).toHaveLength(1);
    });

    it('leaves a C-language object path in a dollar-quoted AS body as DATA', () => {
      // `AS $$$libdir/…$$ LANGUAGE C` is a file path, not SQL. The
      // single-quoted form already had this guard; the two must agree.
      const path = 'p'.repeat(80);
      expect(
        findOverlongIdentifiers(
          '0100_x.sql',
          `CREATE FUNCTION f() RETURNS integer AS $$$libdir/${path}$$ LANGUAGE C;`,
        ),
      ).toEqual([]);
    });

    // Round 12: the body's language is what decides, not a keyword allowlist.
    // `AS $$ TABLE t; $$ LANGUAGE SQL` is a valid body whose only verb is
    // `TABLE`, and an incomplete allowlist made the gate BLIND to it.
    it('classifies a function body by its LANGUAGE clause', () => {
      const name = `t_${'w'.repeat(64)}`;
      expect(
        findOverlongIdentifiers(
          '0100_x.sql',
          `CREATE FUNCTION f() RETURNS SETOF bigint AS $$ TABLE ${name}; $$ LANGUAGE SQL;`,
        ),
      ).toHaveLength(1);
    });

    it('reads a LANGUAGE clause written BEFORE the body', () => {
      const path = 'p'.repeat(80);
      expect(
        findOverlongIdentifiers(
          '0100_x.sql',
          `CREATE FUNCTION f() RETURNS integer LANGUAGE C AS $$$libdir/${path}$$;`,
        ),
      ).toEqual([]);
    });

    it('still scans a dollar-quoted AS body that IS procedural SQL', () => {
      expect(
        findOverlongIdentifiers(
          '0100_x.sql',
          `CREATE FUNCTION f() RETURNS void AS $$ BEGIN CREATE INDEX ${name} ON t (c); END $$ LANGUAGE plpgsql;`,
        ),
      ).toHaveLength(1);
    });
  });

  it('passes ordinary migration SQL untouched', () => {
    const sql = `CREATE TABLE "debate_arenas" ("debate_id" uuid PRIMARY KEY);
                 CREATE INDEX "debate_arenas_story_idx" ON "debate_arenas" ("story_id");
                 ALTER TABLE "debate_arenas" ADD CONSTRAINT "debate_arenas_target_contribution_fk"
                   FOREIGN KEY ("target_contribution_id") REFERENCES "contributions"("contribution_id");`;
    expect(findOverlongIdentifiers('0097_x.sql', sql)).toEqual([]);
  });
});
