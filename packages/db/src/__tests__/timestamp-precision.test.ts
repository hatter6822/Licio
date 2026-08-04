// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Timestamp precision, asked of the SERVER (gated; Postgres).
//
// `check:timestamp-precision` reads what was written down — the schema
// declarations and the migration SQL.  That is worth having on every PR, but it
// cannot see the thing that actually matters: what the running server has.  A
// declaration and a migration can disagree, a migration can fail halfway, and
// an `ALTER … TYPE` can be silently refused for a reason the SQL text does not
// show (the `events_*` partitions refuse it outright — "cannot alter inherited
// column" — and are only reachable through their parent).  So this suite asks
// `information_schema`.
//
// Why any of it matters: a `timestamptz` defaults to MICROSECONDS, and nothing
// in this codebase can hold one — every timestamp is produced by, and read back
// through, a JavaScript `Date`.  A keyset cursor is a value read out of the
// column and sent back, so a microsecond column hands out a cursor rounded DOWN
// to an instant strictly BEFORE its own row; in a descending page every row
// sharing that millisecond sorts after the cursor and is dropped, and the page
// comes back SHORT — which is exactly how a caller decides it reached the end.
// The last leg proves that end-to-end rather than by argument.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('timestamp precision (live server)', () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(DB_URL as string, { onnotice: () => {} });
  });

  afterAll(async () => {
    await sql.end();
  });

  it('holds no microsecond timestamptz column, in any schema', async () => {
    const rows = await sql<{ qualified: string; precision: number }[]>`
      select
        c.table_schema || '.' || c.table_name || '.' || c.column_name as qualified,
        c.datetime_precision as precision
      from information_schema.columns c
      join pg_class pc on pc.relname = c.table_name
      join pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = c.table_schema
      where c.data_type = 'timestamp with time zone'
        and c.table_schema not in ('pg_catalog', 'information_schema')
        -- ordinary tables AND partitioned parents AND their partitions: an
        -- inherited column is a real column and pages like one.
        and pc.relkind in ('r', 'p')
      order by 1`;

    // Fail-closed: finding no columns would mean the query stopped matching,
    // not that the database is clean.
    expect(rows.length).toBeGreaterThan(200);

    const microsecond = rows.filter((row) => row.precision !== 3).map((row) => row.qualified);
    expect(microsecond).toEqual([]);
  });

  it('covers the partition children, which refuse the ALTER themselves', async () => {
    // These are the 32 columns the migration could not name directly; if the
    // parent's rewrite had not carried, they would still be at microseconds
    // while every other check reported success.
    const rows = await sql<{ qualified: string; precision: number }[]>`
      select
        c.relname || '.' || a.attname as qualified,
        information_schema._pg_datetime_precision(a.atttypid, a.atttypmod) as precision
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where a.atttypid = 'timestamptz'::regtype
      order by 1`;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.precision !== 3).map((row) => row.qualified)).toEqual([]);
  });

  /**
   * Page a probe table the way a store does, with the cursor round-tripped
   * through a JavaScript `Date` — which is the entire mechanism.
   */
  const pageThrough = async (table: string): Promise<number[]> => {
    const seen: number[] = [];
    let cursor: { createdAt: Date; id: number } | null = null;
    for (let page = 0; page < 20; page++) {
      const rows: { id: number; created_at: Date }[] = cursor
        ? await sql.unsafe(
            `select id, created_at from "${table}"
             where (created_at, id) < ($1::timestamptz, $2::int)
             order by created_at desc, id desc limit 7`,
            [cursor.createdAt.toISOString(), cursor.id],
          )
        : await sql.unsafe(
            `select id, created_at from "${table}" order by created_at desc, id desc limit 7`,
          );
      if (rows.length === 0) break;
      for (const row of rows) seen.push(row.id);
      const last = rows[rows.length - 1] as { id: number; created_at: Date };
      // The store reads `created_at` back as a `Date`, so this is already
      // rounded — there is nowhere else for the precision to go.
      cursor = { createdAt: last.created_at, id: last.id };
    }
    return seen;
  };

  /** 40 rows 137µs apart — several per millisecond, distinct at microseconds. */
  const seedProbe = async (table: string, columnType: string): Promise<void> => {
    await sql.unsafe(
      `create table "${table}" (id int not null, created_at ${columnType} not null)`,
    );
    await sql.unsafe(
      `insert into "${table}" (id, created_at)
       select g, now() + (g * interval '137 microseconds') from generate_series(1, 40) g`,
    );
  };

  it('loses rows at MICROSECOND precision — the control for the leg below', async () => {
    // Without this the next test proves nothing: a probe whose rows do not
    // actually share a millisecond passes at either precision, which is how
    // the first cut of this suite managed to be green and vacuous.
    const table = `_precision_control_${process.pid}`;
    await sql.unsafe(`drop table if exists "${table}"`);
    await seedProbe(table, 'timestamptz');
    try {
      const seen = await pageThrough(table);
      expect(seen.length).toBeLessThan(40);
    } finally {
      await sql.unsafe(`drop table if exists "${table}"`);
    }
  });

  it('loses none at the declared millisecond precision', async () => {
    const table = `_precision_probe_${process.pid}`;
    await sql.unsafe(`drop table if exists "${table}"`);
    await seedProbe(table, 'timestamptz(3)');
    try {
      const seen = await pageThrough(table);
      // Every row, exactly once — no short page, nothing skipped, no repeat.
      expect([...seen].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 40 }, (_, index) => index + 1),
      );
      expect(new Set(seen).size).toBe(40);
    } finally {
      await sql.unsafe(`drop table if exists "${table}"`);
    }
  });
});
