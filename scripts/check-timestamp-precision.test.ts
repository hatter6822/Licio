// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit coverage for the timestamp-precision gate.
//
// The LIVE-tree cases are the point.  The first cut of this gate discovered its
// own schema files with `git ls-files 'packages/db/src/schema/**/*.ts'` — a git
// pathspec is not a shell glob, so it matched the ONE file in a subdirectory,
// read 1 of 35, and printed "passed".  Its emptiness guard let that through
// because 1 is not 0.  So the live case here asserts the COUNT it read, not
// just the verdict: a gate that judges nothing must not be able to look green.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findBareMigrationTypes,
  findSchemaDeclarations,
  type PrecisionFinding,
} from './check-timestamp-precision.js';
import { withParsedSources } from './ts-source.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

const scanSchema = (
  content: string,
  path = 'packages/db/src/schema/thing.ts',
): PrecisionFinding[] =>
  withParsedSources([{ path, content }], (parsed) => findSchemaDeclarations(parsed));

const scanSql = (content: string): PrecisionFinding[] =>
  findBareMigrationTypes([{ path: 'packages/db/drizzle/0130_thing.sql', content }]);

describe('the schema half', () => {
  it('fails a bare timestamp() declaration', () => {
    const findings = scanSchema(`
      import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
      export const things = pgTable('things', {
        id: uuid('id').primaryKey(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      });
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain('instant()');
  });

  it('fails it even when it passes precision itself — one helper, one place', () => {
    // `precision: 3` here is CORRECT sql and still a finding: the value of the
    // helper is that it cannot be spelled two ways, which is how four schema
    // files each ended up with their own local copy of it.
    const findings = scanSchema(`
      import { pgTable, timestamp } from 'drizzle-orm/pg-core';
      export const things = pgTable('things', {
        createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }),
      });
    `);
    expect(findings).toHaveLength(1);
  });

  it('catches the multi-line form a line-based scan misses', () => {
    // Two of these existed, and a single-line regex converted neither.
    const findings = scanSchema(`
      import { pgTable, timestamp } from 'drizzle-orm/pg-core';
      export const things = pgTable('things', {
        lastActiveAt: timestamp('last_active_at', {
          withTimezone: true,
        }).notNull(),
      });
    `);
    expect(findings).toHaveLength(1);
  });

  it('passes instant()', () => {
    expect(
      scanSchema(`
        import { pgTable, uuid } from 'drizzle-orm/pg-core';
        import { instant } from './_custom.js';
        export const things = pgTable('things', {
          id: uuid('id').primaryKey(),
          createdAt: instant('created_at').notNull().defaultNow(),
        });
      `),
    ).toEqual([]);
  });

  it('reads from the parse, so the WORD timestamp is not a declaration', () => {
    expect(
      scanSchema(`
        import { instant } from './_custom.js';
        /** The timestamp() spelling is what this replaced. */
        const label = 'timestamp(';
        export const at = instant('at');
        export const fromRow = (row: { timestamp: Date }) => row.timestamp;
      `),
    ).toEqual([]);
  });

  it('exempts the helper file itself — it is where the one call lives', () => {
    const content = `
      import { timestamp } from 'drizzle-orm/pg-core';
      export const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
    `;
    expect(scanSchema(content, 'packages/db/src/schema/_custom.ts')).toEqual([]);
    // …and the SAME text anywhere else is a finding, so the exemption is the
    // file and not the pattern.
    expect(scanSchema(content, 'packages/db/src/schema/other.ts')).toHaveLength(1);
  });
});

describe('the migration half', () => {
  it('fails a bare timestamptz', () => {
    const findings = scanSql(`ALTER TABLE "things" ADD COLUMN "created_at" timestamptz NOT NULL;`);
    expect(findings).toHaveLength(1);
  });

  it('fails the spelled-out form', () => {
    expect(
      scanSql(`CREATE TABLE "things" ("created_at" timestamp with time zone NOT NULL);`),
    ).toHaveLength(1);
  });

  it('fails a WRONG precision, not merely a missing one', () => {
    expect(scanSql(`ALTER TABLE "t" ALTER COLUMN "c" TYPE timestamptz(6);`)).toHaveLength(1);
  });

  it('passes timestamptz(3), including odd spacing', () => {
    expect(
      scanSql(`
        ALTER TABLE "t" ALTER COLUMN "a" TYPE timestamptz(3);
        ALTER TABLE "t" ADD COLUMN "b" timestamptz( 3 ) NOT NULL;
      `),
    ).toEqual([]);
  });

  it('does not read comments as DDL', () => {
    expect(
      scanSql(`
        -- this used to be a bare timestamptz column
        ALTER TABLE "t" ALTER COLUMN "a" TYPE timestamptz(3); -- was timestamptz
      `),
    ).toEqual([]);
  });
});

describe('the live tree', () => {
  const schemaDir = 'packages/db/src/schema';
  const schemaPaths = readdirSync(resolve(ROOT, schemaDir), { recursive: true, encoding: 'utf-8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `${schemaDir}/${name}`);

  it('COUNTS the schema files it read, so a discovery bug cannot look green', () => {
    // The whole schema, not one file in a subdirectory.
    expect(schemaPaths.length).toBeGreaterThan(30);
  });

  it('declares no microsecond column anywhere in the schema', () => {
    const sources = schemaPaths.map((path) => ({
      path,
      content: readFileSync(resolve(ROOT, path), 'utf-8'),
    }));
    expect(withParsedSources(sources, (parsed) => findSchemaDeclarations(parsed))).toEqual([]);
  });

  it('has the migration that narrows every pre-existing column', () => {
    const migrations = readdirSync(resolve(ROOT, 'packages/db/drizzle')).filter((name) =>
      name.endsWith('.sql'),
    );
    const precision = migrations.filter((name) =>
      name.endsWith('_timestamp_millisecond_precision.sql'),
    );
    expect(precision).toHaveLength(1);

    // It must actually carry the ALTERs — an empty file with the right name
    // would satisfy the gate's boundary lookup and change nothing.
    const sql = readFileSync(resolve(ROOT, 'packages/db/drizzle', precision[0] as string), 'utf-8');
    const alters = sql.split('\n').filter((line) => line.startsWith('ALTER TABLE'));
    expect(alters.length).toBeGreaterThan(200);
    expect(alters.every((line) => line.includes('TYPE timestamptz(3);'))).toBe(true);
  });
});
