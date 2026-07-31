// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EVERY UNIT TAKES THE GLOBAL LOCK LAST.
//
// The chained audit append ends with `SELECT pg_advisory_xact_lock(…)`, which serialises
// writers on the one global moderation chain.  It is therefore the only GLOBAL lock a
// unit of work acquires; everything else it takes is a row lock on the rows it touches.
//
// That makes the lock order trivially safe as long as it is acquired LAST: every unit
// takes row locks first and the advisory lock at the end, which is one consistent order
// across all of them, and a consistent order cannot cycle.
//
// Audit somewhere in the middle breaks it.  A unit that audits and then writes a notice
// holds the advisory lock while waiting on a `moderation_notices` lock, while
// `performRevert` and the appeal decision hold notices locks while waiting on the
// advisory one.  Two of those interleave into a deadlock — a real one, in Postgres, that
// no amount of retrying fixes.  It shipped exactly once, in the auto-block sink, and it
// is the kind of thing that is invisible in review and impossible to reproduce on demand.
//
// So it is checked mechanically.  A static scan is crude, but it reads every unit,
// including the one written next month by someone who never saw this comment.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Every file that opens a moderation unit of work. */
const UNIT_FILES = [
  'src/moderation/actions.ts',
  'src/moderation/appeals.ts',
  'src/moderation/forum-integration.ts',
  'src/moderation/incidents.ts',
  'src/moderation/reports.ts',
  'src/moderation/scheduler.ts',
  'src/routes/moderation-console.ts',
] as const;

interface Unit {
  file: string;
  line: number;
  calls: string[];
}

/** The body of each `transactor.run(async (tx) => { … })`, by brace matching. */
function unitsIn(file: string): Unit[] {
  const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const units: Unit[] = [];
  const opener = /transactor\.run\(async \(tx[^)]*\) => \{/g;
  for (let m = opener.exec(source); m !== null; m = opener.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0 && i < source.length) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    const body = source.slice(m.index + m[0].length, i);
    // `tx.audit(…)` and `tx.<store>.…`, plus the tx stores handed to a helper
    // (`createActionNotice(…, tx.notices)`), which write just as directly.
    const calls = [...body.matchAll(/\btx\.(\w+)/g)].map((c) => c[1] as string);
    units.push({ file, line: source.slice(0, m.index).split('\n').length, calls });
  }
  return units;
}

const ALL_UNITS = UNIT_FILES.flatMap(unitsIn);

describe('moderation units acquire the chain lock last', () => {
  it('finds every unit, so the scan cannot pass by matching nothing', () => {
    // A regex that silently stops matching would make every assertion below vacuous.
    expect(ALL_UNITS.length).toBeGreaterThanOrEqual(11);
    expect(ALL_UNITS.every((u) => u.calls.length > 0)).toBe(true);
  });

  it('never writes through `tx` after `tx.audit`', () => {
    const offenders = ALL_UNITS.filter((u) => {
      const audit = u.calls.lastIndexOf('audit');
      return audit !== -1 && audit !== u.calls.length - 1;
    }).map((u) => `${u.file}:${u.line} → ${u.calls.join(' → ')}`);

    // Naming the order rather than just failing: whoever trips this needs to know that
    // moving one call fixes it, and why the call is the audit and not the other one.
    expect(offenders).toEqual([]);
  });
});
