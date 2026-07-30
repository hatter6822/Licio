// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Single-source pin for EVERY Postgres enum: the Drizzle schema declares the
// value list in TypeScript, the hand-authored migration writes its own literal
// (`docs/DEVELOPMENT.md` §15 — `db:generate` is never run here), and nothing
// made the two agree.
//
// The drift is silent in the direction that matters.  A value the STORE can
// produce but the migration lacks fails only when a row is written; a value the
// MIGRATION carries but the TS list lacks type-checks everywhere and then fails
// at the first `z.enum` parse of a row that holds it — which is how a terminal
// `grant_payout_state` of `closed` came to answer every read of a room's grants
// with a 500.  `z.parse` takes `unknown`, so the compiler had nothing to say.
//
// This asserts set equality for all of them at once, so the next enum to gain a
// value cannot reach the remote half-added.  Order is deliberately NOT compared:
// Postgres enum order is physical (it decides `ORDER BY` on the column) and
// `ALTER TYPE … ADD VALUE` appends, so the TS list and the migration chain are
// free to disagree about position while meaning the same set.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as sharedSchemas from '@licio/shared';
import { describe, expect, it } from 'vitest';
import * as schema from '../schema/index.js';

const DRIZZLE_DIR = join(import.meta.dirname, '../../drizzle');

/** A Drizzle `pgEnum` / `pgSchema().enum()` object, structurally identified. */
interface EnumObject {
  readonly enumName: string;
  readonly enumValues: readonly string[];
  readonly schema?: string | undefined;
}

// Generic in the INPUT so `.filter(isEnumObject)` narrows to `T & EnumObject`
// rather than failing to narrow at all: the schema barrel's `Object.values` is a
// 270-member union, and `value is EnumObject` on an `unknown` parameter is not
// assignable to it, so the filter left every element at the full union type.
function isEnumObject<T>(value: T): value is T & EnumObject {
  // A Drizzle enum is CALLABLE (`myEnum('column_name')` builds the column), so
  // `typeof` is `'function'` and an `=== 'object'` test finds none of them —
  // which left the whole suite passing over an empty list.  That is exactly the
  // failure the first assertion below exists to catch.
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const candidate = value as { enumName?: unknown; enumValues?: unknown };
  return typeof candidate.enumName === 'string' && Array.isArray(candidate.enumValues);
}

/** `<schema>.<name>` for both sides, so a `public` enum and a schema-qualified
 *  one of the same name never collide. */
function qualify(schemaName: string | undefined, enumName: string): string {
  return `${schemaName ?? 'public'}.${enumName}`;
}

/** One `"schema"."name"` or bare `"name"` reference, normalized. */
const TYPE_REF = String.raw`(?:"([a-z_][a-z0-9_]*)"\s*\.\s*)?"([a-z_][a-z0-9_]*)"`;

/**
 * REPLAY the chain in statement order and report the enums Postgres is left
 * holding.
 *
 * Order is not a detail here.  This chain retires an enum by SWAPPING it —
 * `CREATE TYPE foo_v2`, migrate the column, `DROP TYPE foo`,
 * `ALTER TYPE foo_v2 RENAME TO foo` (and the mirror form, renaming the old one
 * to `foo_old` first) — so a parser that collects every `CREATE TYPE` in one
 * pass and every `ADD VALUE` in another reports the DEAD pre-swap vocabulary
 * under the live name and the live one under a `_v2` name that no longer
 * exists.  A first draft of this test did exactly that and accused ten healthy
 * enums, including five compliance audit events whose `ADD VALUE` it missed
 * only because it demanded a schema qualifier the chain does not always write.
 * Both spellings are legal SQL, so both are parsed.
 */
function migrationEnumValues(): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  const statementRe = new RegExp(
    [
      String.raw`CREATE\s+TYPE\s+${TYPE_REF}\s+AS\s+ENUM\s*\(([^)]*)\)`,
      String.raw`ALTER\s+TYPE\s+${TYPE_REF}\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']*)'`,
      String.raw`ALTER\s+TYPE\s+${TYPE_REF}\s+RENAME\s+TO\s+"([a-z_][a-z0-9_]*)"`,
      String.raw`DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?${TYPE_REF}`,
    ]
      .map((alt) => `(?:${alt})`)
      .join('|'),
    'gis',
  );
  for (const file of readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    // `matchAll` yields in source order, which is what makes the replay faithful.
    for (const m of readFileSync(join(DRIZZLE_DIR, file), 'utf8').matchAll(statementRe)) {
      const [
        ,
        cSchema,
        cName,
        cValues,
        aSchema,
        aName,
        aValue,
        rSchema,
        rName,
        rTo,
        dSchema,
        dName,
      ] = m;
      if (cName !== undefined) {
        byName.set(
          qualify(cSchema, cName),
          new Set([...(cValues ?? '').matchAll(/'([^']*)'/g)].map((v) => v[1] as string)),
        );
      } else if (aName !== undefined) {
        const key = qualify(aSchema, aName);
        // An ADD VALUE with no live type before it is itself a defect — record it
        // so the comparison reports the mismatch rather than ignoring it.
        const existing = byName.get(key) ?? new Set<string>();
        existing.add(aValue as string);
        byName.set(key, existing);
      } else if (rName !== undefined && rTo !== undefined) {
        // RENAME TO names the new type WITHOUT a qualifier: it stays put.
        const from = qualify(rSchema, rName);
        const values = byName.get(from);
        byName.delete(from);
        if (values !== undefined) byName.set(qualify(rSchema, rTo), values);
      } else if (dName !== undefined) {
        byName.delete(qualify(dSchema, dName));
      }
    }
  }
  return byName;
}

describe('Postgres enum schema↔migration parity', () => {
  const declared = Object.values(schema).filter(isEnumObject);
  const inMigrations = migrationEnumValues();

  it('finds the enums on both sides (the parse itself must not silently yield nothing)', () => {
    // Guards the regexes above: a syntax the chain uses but they do not match
    // would make every assertion below pass over an empty set.
    expect(declared.length).toBeGreaterThan(40);
    expect(inMigrations.size).toBeGreaterThan(40);
  });

  it.each(declared.map((e) => [qualify(e.schema, e.enumName), e] as const))(
    '%s carries the same value set in TypeScript and in the migration chain',
    (key, enumObject) => {
      const migrationValues = inMigrations.get(key);
      expect(migrationValues, `no CREATE TYPE for ${key} in the migration chain`).toBeDefined();
      expect([...(migrationValues ?? [])].sort()).toEqual([...enumObject.enumValues].sort());
    },
  );

  it('every enum the migrations create is declared in the TypeScript schema', () => {
    const declaredKeys = new Set(declared.map((e) => qualify(e.schema, e.enumName)));
    // The direction that type-checks and then fails at runtime: a value or a
    // whole type living in Postgres that no TS list can spell.
    expect([...inMigrations.keys()].filter((k) => !declaredKeys.has(k))).toEqual([]);
  });
});

/**
 * The WIRE half of the same vocabulary.
 *
 * The gate above proves the Drizzle schema and Postgres agree; it says nothing
 * about `@licio/shared`, which is where the same list is spelled a THIRD time
 * for `z.enum` — and that is the copy that broke.  `grant_payout_state` gained
 * `closed` in the DB enum, the migration and the store's row type, and the
 * shared list was left behind; because the grants route parses its whole answer
 * through that list server-side and a `ZodError` is not an `HTTPException`, one
 * settled grant turned every read of that room's grants into a 500, for good.
 *
 * Pairing is BY NAME (`GRANT_PAYOUT_STATES` → `grant_payout_state`) rather than
 * from a hand-maintained table, so a vocabulary added to both sides is checked
 * from the moment it exists instead of when someone remembers to list it.
 */
const SHARED_ENUM_EXCEPTIONS: Readonly<Record<string, { sharedOnly: string[]; why: string }>> = {
  deletion_state: {
    sharedOnly: ['none'],
    // `none` is the ABSENCE of a row, not a row's state: `toDeletionStatus`
    // reports it when `getDeletion` returns nothing (or a cancelled request),
    // so the column is never asked to hold it.
    why: 'API-only sentinel for "no deletion request exists"',
  },
};

describe('Postgres enum↔@licio/shared wire vocabulary parity', () => {
  const dbEnums = new Map(
    Object.values(schema)
      .filter(isEnumObject)
      .map((e) => [e.enumName, [...e.enumValues]] as const),
  );

  /** Exported `SCREAMING_SNAKE` arrays of strings — the vocabulary constants. */
  const sharedVocabularies = Object.entries(sharedSchemas).filter(
    (entry): entry is [string, readonly string[]] =>
      /^[A-Z][A-Z0-9_]*$/.test(entry[0]) &&
      Array.isArray(entry[1]) &&
      entry[1].length > 0 &&
      entry[1].every((v) => typeof v === 'string'),
  );

  const pairs = sharedVocabularies.flatMap(([name, values]) => {
    const enumName = name.toLowerCase().replace(/s$/, '');
    const dbValues = dbEnums.get(enumName) ?? dbEnums.get(name.toLowerCase());
    return dbValues === undefined ? [] : [[name, enumName, values, dbValues] as const];
  });

  it('pairs the vocabularies it is meant to check', () => {
    // Same premise guard as above: a singularization rule that stopped matching
    // would leave every assertion below iterating over nothing.
    expect(pairs.length).toBeGreaterThan(45);
    expect(pairs.map(([, enumName]) => enumName)).toContain('grant_payout_state');
  });

  it.each(pairs)('%s matches the %s enum', (_name, enumName, sharedValues, dbValues) => {
    const exception = SHARED_ENUM_EXCEPTIONS[enumName];
    // Retired labels are the one legitimate asymmetry in the other direction:
    // Postgres cannot drop an enum value, so an append-only table keeps the
    // label for rows that already carry it while the WRITE vocabulary moves on.
    // `storedAuditEventTypeSchema` is that union, so the read side is exact.
    const retired =
      enumName === 'audit_event_type' ? [...sharedSchemas.RETIRED_AUDIT_EVENT_TYPES] : [];
    const expected = [...dbValues, ...(exception?.sharedOnly ?? [])].sort();
    expect([...sharedValues, ...retired].sort(), exception?.why ?? '').toEqual(expected);
  });
});
