// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Single-source pin for the invariant-type vocabulary: the schema CHECK is
// DERIVED from `INVARIANT_TYPE_DB_VALUES` (schema/events.ts `inList`), but the
// hand-authored migration writes its own literal — this asserts the LATEST
// migration `invariant_outputs_type` CHECK lists exactly the array, so the two
// can never silently drift (a new invariant added to the array without the
// matching migration, or vice versa, fails here — no live Postgres needed).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVARIANT_TARGET_DB_VALUES, INVARIANT_TYPE_DB_VALUES } from '../schema/events.js';

const DRIZZLE_DIR = join(import.meta.dirname, '../../drizzle');

/** The value set of the LAST `<column> in (...)` CHECK across the whole
 *  migration chain (the constraint the live DB actually carries). */
function latestCheckValues(column: string): string[] {
  const re = new RegExp(`"${column}" in \\(([^)]*)\\)`, 'g');
  let last: string | null = null;
  for (const file of readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(DRIZZLE_DIR, file), 'utf8');
    for (const match of sql.matchAll(re)) last = match[1] ?? last;
  }
  if (last === null) throw new Error(`no CHECK found for column ${column}`);
  return [...last.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

describe('invariant vocabulary migration↔array parity', () => {
  it('the latest invariant_outputs type CHECK lists exactly INVARIANT_TYPE_DB_VALUES', () => {
    expect(latestCheckValues('invariant_type').sort()).toEqual(
      [...INVARIANT_TYPE_DB_VALUES].sort(),
    );
  });

  it('the latest invariant_outputs target_type CHECK lists exactly INVARIANT_TARGET_DB_VALUES', () => {
    expect(latestCheckValues('target_type').sort()).toEqual([...INVARIANT_TARGET_DB_VALUES].sort());
  });

  it('behavioral_authenticity (the 12th family) is in the vocabulary', () => {
    expect(INVARIANT_TYPE_DB_VALUES).toContain('behavioral_authenticity');
  });
});
