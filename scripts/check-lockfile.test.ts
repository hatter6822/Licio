// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The lockfile gate had NO unit coverage, which is how two holes survived in
// it: a ratio that sat permanently on its own threshold, and an integrity
// check that counted the algorithm prefix without a digest.  Both are pinned
// here against the shape a real pnpm lockfile has.
import { describe, expect, it } from 'vitest';
import { countPackagesSection } from './check-lockfile.js';

/** A lockfile fragment with the section layout pnpm actually emits. */
const lockfile = (packages: string, snapshots = ''): string =>
  [
    'lockfileVersion: "9.0"',
    '',
    'importers:',
    '  .:',
    '    dependencies:',
    '      zod:',
    '        specifier: ^4.4.0',
    '        version: 4.4.0',
    '',
    'packages:',
    packages,
    '',
    'snapshots:',
    snapshots,
  ].join('\n');

const digest = (seed: string): string => `${seed}${'A'.repeat(86 - seed.length)}==`;

describe('counting the packages section', () => {
  it('counts entries and digests in `packages:` ALONE', () => {
    // A pnpm lockfile lists every package TWICE — once with its resolution and
    // again under `snapshots:` with its graph — so a count over the whole file
    // is about double, which is what made the old ratio meaningless.
    const content = lockfile(
      [
        `  a@1.0.0:`,
        `    resolution: {integrity: sha512-${digest('a')}}`,
        `  b@2.0.0:`,
        `    resolution: {integrity: sha512-${digest('b')}}`,
      ].join('\n'),
      ['  a@1.0.0: {}', '  b@2.0.0: {}'].join('\n'),
    );
    expect(countPackagesSection(content)).toEqual({ entries: 2, integrity: 2 });
  });

  it.each([
    ['an EMPTY digest', 'sha512-'],
    ['a non-base64 digest', 'sha512-not!base64'],
    ['a digest too short for the algorithm', 'sha512-abc123'],
  ])('does not count %s as an integrity hash', (_label, value) => {
    // Counting the algorithm PREFIX accepted a lockfile whose every digest had
    // been emptied — the exact substitution this gate exists to notice.
    const content = lockfile([`  a@1.0.0:`, `    resolution: {integrity: ${value}}`].join('\n'));
    expect(countPackagesSection(content)).toEqual({ entries: 1, integrity: 0 });
  });

  it('accepts sha256 and sha384 as well as sha512', () => {
    const content = lockfile(
      [
        `  a@1.0.0:`,
        `    resolution: {integrity: sha256-${'A'.repeat(43)}=}`,
        `  b@1.0.0:`,
        `    resolution: {integrity: sha384-${'B'.repeat(64)}}`,
      ].join('\n'),
    );
    expect(countPackagesSection(content).integrity).toBe(2);
  });

  it('reads the REAL lockfile as fully covered', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const real = readFileSync(resolve(import.meta.dirname, '..', 'pnpm-lock.yaml'), 'utf-8');
    const { entries, integrity } = countPackagesSection(real);
    expect(entries).toBeGreaterThan(100);
    expect(integrity).toBe(entries);
  });
});
