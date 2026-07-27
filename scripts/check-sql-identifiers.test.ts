// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The identifier-length gate is what stops silent Postgres name truncation from
// returning, so it is pinned in both directions: a name at the limit fails, and
// the ordinary SQL around it does not.
//
// It reads the migration with the SERVER'S OWN PARSER, which has two
// consequences the tests below exist to fix in place.  The parser applies the
// server's limit, so an over-long name arrives ALREADY TRUNCATED and the gate
// necessarily detects the SIGNATURE rather than the original length.  And the
// parser understands SQL, so the lexical cases a hand-written scanner needed a
// rule apiece for — `""` escapes, `U&"…"`, `E'…'`, dollar quoting — are simply
// not this file's problem any more.
//
// What the parser cannot see — a name DERIVED by Drizzle, or one composed at
// runtime inside `EXECUTE format(…)` — is covered exactly by the migration
// harness, which listens for Postgres's own truncation NOTICE while applying
// the whole chain.  Those cases are asserted there, against a real server,
// rather than approximated here.
import { describe, expect, it } from 'vitest';
import { PG_MAX_IDENTIFIER_BYTES } from '../packages/db/src/identifier-limits.js';
import { findOverlongIdentifiers, identifiersIn } from './check-sql-identifiers.js';

/** An identifier of exactly `bytes` ASCII bytes. */
const ident = (bytes: number): string => `a${'b'.repeat(bytes - 1)}`;

const OVER = ident(PG_MAX_IDENTIFIER_BYTES + 1);
const AT = ident(PG_MAX_IDENTIFIER_BYTES);
const UNDER = ident(PG_MAX_IDENTIFIER_BYTES - 1);

describe('findOverlongIdentifiers', () => {
  it('flags a name Postgres would truncate', async () => {
    const found = await findOverlongIdentifiers('0099_x.sql', `CREATE INDEX "${OVER}" ON t (c);`);
    // Reported at 63 bytes, not 64: the parser already cut it, which is the
    // very normalisation the gate exists to notice.
    expect(found).toEqual([
      { file: '0099_x.sql', identifier: OVER.slice(0, 63), bytes: PG_MAX_IDENTIFIER_BYTES },
    ]);
  });

  it('flags a name that merely SITS at the limit, since the two are indistinguishable', async () => {
    // The parser hands back 63 bytes either way.  Rather than guess, the gate
    // asks for the genuine ones to be declared — and the harness settles it
    // authoritatively against a real server.
    expect(await findOverlongIdentifiers('0099_x.sql', `CREATE INDEX "${AT}" ON t (c);`)).toEqual([
      { file: '0099_x.sql', identifier: AT, bytes: PG_MAX_IDENTIFIER_BYTES },
    ]);
  });

  it('leaves a name comfortably under the limit alone', async () => {
    expect(
      await findOverlongIdentifiers('0099_x.sql', `CREATE INDEX "${UNDER}" ON t (c);`),
    ).toEqual([]);
  });

  it.each([
    ['a table', `CREATE TABLE "${OVER}" (id int);`],
    ['a column', `CREATE TABLE t ("${OVER}" int);`],
    ['a constraint', `ALTER TABLE t ADD CONSTRAINT "${OVER}" CHECK (id > 0);`],
    ['a trigger', `CREATE TRIGGER "${OVER}" BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();`],
    ['a sequence', `CREATE SEQUENCE "${OVER}";`],
    ['a schema', `CREATE SCHEMA "${OVER}";`],
    ['a type', `CREATE TYPE "${OVER}" AS ENUM ('a');`],
    ['an UNQUOTED name', `CREATE INDEX ${OVER} ON t (c);`],
  ])('sees %s, without a list of DDL forms', async (_label, sql) => {
    // Every string in the parse tree is a candidate, so no DDL form has to be
    // enumerated and none can be left out of the enumeration.
    expect(await findOverlongIdentifiers('0099_x.sql', sql)).toHaveLength(1);
  });

  it.each([
    ['a string literal', `INSERT INTO t (note) VALUES ('${'z'.repeat(80)}');`],
    ['a column DEFAULT', `CREATE TABLE t (note text DEFAULT '${'z'.repeat(80)}');`],
    ['a COMMENT', `COMMENT ON TABLE t IS '${'z'.repeat(80)}';`],
    [
      'a function BODY',
      `CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN ${'-- '.repeat(30)} RETURN NEW; END; $$ LANGUAGE plpgsql;`,
    ],
    ['a DO body', `DO $$ BEGIN PERFORM 1; ${'-- '.repeat(30)} END $$;`],
  ])('does not mistake %s for a name', async (_label, sql) => {
    expect(await findOverlongIdentifiers('0099_x.sql', sql)).toEqual([]);
  });

  it('measures BYTES, not characters', async () => {
    // A multi-byte name reaches the limit in fewer characters, and Postgres
    // clips to a character boundary rather than splitting a sequence.
    const name = `é${'b'.repeat(PG_MAX_IDENTIFIER_BYTES - 1)}`; // 64 bytes, 63 chars
    expect(
      await findOverlongIdentifiers('0099_x.sql', `CREATE INDEX "${name}" ON t (c);`),
    ).toHaveLength(1);
  });

  it('reports each distinct name once, however often it repeats', async () => {
    const sql = `CREATE INDEX "${OVER}" ON t (c); DROP INDEX "${OVER}"; CREATE INDEX "${OVER}" ON u (c);`;
    expect(await findOverlongIdentifiers('0099_x.sql', sql)).toHaveLength(1);
  });

  it('rejects SQL it cannot parse rather than reporting it clean', async () => {
    // A migration this gate cannot read is one it must not vouch for.
    await expect(findOverlongIdentifiers('0099_x.sql', 'CREATE TABLE (((')).rejects.toThrow();
  });
});

describe('declared exceptions', () => {
  const HISTORICAL = 'debate_arenas_target_contribution_id_contributions_contribution_id_fk';
  const LEGITIMATE = 'model_ratification_ballot_vote_id_model_ratification_vote_id_fk';

  it('accepts a historically-truncated name in the migration that applied it', async () => {
    // Applied history is immutable; 0097 renames what these created.  The gate
    // sees the TRUNCATED form because the parser cut it, while the harness sees
    // the intended one in Postgres's notice — the exemption matches both.
    const sql = `ALTER TABLE t ADD CONSTRAINT "${HISTORICAL}" FOREIGN KEY (a) REFERENCES u (b);`;
    expect(await findOverlongIdentifiers('0056_ws_t_debate_arena.sql', sql)).toEqual([]);
  });

  it('does NOT accept the same name in a NEW migration', async () => {
    const sql = `ALTER TABLE t ADD CONSTRAINT "${HISTORICAL}" FOREIGN KEY (a) REFERENCES u (b);`;
    expect(await findOverlongIdentifiers('0099_new.sql', sql)).toHaveLength(1);
  });

  it('accepts a declared name that genuinely sits at the limit', async () => {
    const sql = `ALTER TABLE t ADD CONSTRAINT "${LEGITIMATE}" FOREIGN KEY (a) REFERENCES u (b);`;
    expect(await findOverlongIdentifiers('0037_ws_u_model_ratification.sql', sql)).toEqual([]);
  });

  it('does NOT accept that name in another migration', async () => {
    const sql = `ALTER TABLE t ADD CONSTRAINT "${LEGITIMATE}" FOREIGN KEY (a) REFERENCES u (b);`;
    expect(await findOverlongIdentifiers('0099_new.sql', sql)).toHaveLength(1);
  });
});

describe('identifiersIn', () => {
  it('collects names from every position without enumerating them', async () => {
    const names = await identifiersIn('CREATE INDEX "idx_a" ON "tbl_b" ("col_c");');
    expect(names).toEqual(expect.arrayContaining(['idx_a', 'tbl_b', 'col_c']));
  });

  it('handles the lexical spellings a hand-written scanner needed rules for', async () => {
    // Each of these cost the previous implementation a commit.  The parser is
    // the server's, so none of them is this file's problem any more.
    const names = await identifiersIn(
      [
        `CREATE INDEX "an ""escaped"" quote" ON t (c);`,
        `CREATE INDEX U&"d\\0061ta" ON t (c);`,
        `INSERT INTO t (a) VALUES (E'not\\'an identifier');`,
        `CREATE FUNCTION f() RETURNS int AS $tag$ SELECT 1; $tag$ LANGUAGE sql;`,
      ].join('\n'),
    );
    expect(names).toEqual(expect.arrayContaining(['an "escaped" quote', 'data']));
    expect(names.some((name) => name.includes('an identifier'))).toBe(false);
  });
});
