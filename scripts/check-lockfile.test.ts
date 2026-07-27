// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The lockfile gate had NO unit coverage, which is how two holes survived in
// it: a ratio that sat permanently on its own threshold, and an integrity
// check that counted the algorithm prefix without a digest.  Both are pinned
// here against the shape a real pnpm lockfile has.
import { createHash } from 'node:crypto';
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
    // A single shared 40-character minimum accepted every one of these: none
    // encodes a digest of the algorithm it declares, and the first three are
    // the exact fixtures that minimum let through.
    ['a 40-character digest under sha256', `sha256-${'A'.repeat(40)}`],
    ['a 40-character digest under sha384', `sha384-${'A'.repeat(40)}`],
    ['a 40-character digest under sha512', `sha512-${'A'.repeat(40)}`],
    ['a digest one character short', `sha512-${'A'.repeat(85)}==`],
    ['a digest one character long', `sha512-${'A'.repeat(87)}==`],
    ['a sha256 digest declared as sha512', `sha512-${'A'.repeat(43)}=`],
    ['a sha512 digest declared as sha256', `sha256-${'A'.repeat(86)}==`],
    // Base64 that decodes to the right SIZE but is not the canonical encoding
    // of those bytes: the final character carries padding bits that a real
    // encoder always leaves zero, and Node's LENIENT decoder discards them.
    ['a digest with non-canonical padding bits', `sha512-${'A'.repeat(85)}B==`],
    // A broken algorithm is not coverage, however well-formed its digest.
    ['a sha1 digest', `sha1-${'A'.repeat(27)}=`],
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

  it.each([
    ['sha256', 32],
    ['sha384', 48],
    ['sha512', 64],
  ])('counts a real %s digest of a real payload', (algorithm, bytes) => {
    // Generated rather than hand-shaped, so the fixture is whatever the
    // algorithm actually emits — padding bits and all — for every size.
    const encoded = createHash(algorithm).update('licio').digest('base64');
    expect(Buffer.from(encoded, 'base64').byteLength).toBe(bytes);
    const content = lockfile(
      [`  a@1.0.0:`, `    resolution: {integrity: ${algorithm}-${encoded}}`].join('\n'),
    );
    expect(countPackagesSection(content)).toEqual({ entries: 1, integrity: 1 });
  });

  it('does not let one entry"s extra digest cover for another entry"s missing one', () => {
    // Two running totals compared at the end can be EQUAL while a package is
    // uncovered: a second `integrity:` anywhere in the first entry's subtree
    // balanced out the second entry having no hash at all, and the gate
    // reported full coverage over it.
    const content = lockfile(
      [
        '  a@1.0.0:',
        `    resolution: {integrity: sha512-${digest('a')}}`,
        '    peerDependenciesMeta:',
        `      x: {integrity: sha512-${digest('b')}}`,
        '  b@2.0.0:',
        '    resolution: {}',
      ].join('\n'),
    );
    expect(countPackagesSection(content)).toEqual({ entries: 2, integrity: 1 });
  });

  it('accepts a resolution written as a YAML BLOCK, as pnpm does', () => {
    // Requiring the flow spelling rejected an integrity-covered package
    // outright — a gate refusing valid input, which is worse than one that
    // misses.
    const content = lockfile(
      ['  a@1.0.0:', '    resolution:', `      integrity: sha512-${digest('a')}`].join('\n'),
    );
    expect(countPackagesSection(content)).toEqual({ entries: 1, integrity: 1 });
  });

  it('does not let a block resolution vouch for the NEXT entry', () => {
    const content = lockfile(
      [
        '  a@1.0.0:',
        '    resolution:',
        `      integrity: sha512-${digest('a')}`,
        '  b@2.0.0:',
        '    resolution:',
      ].join('\n'),
    );
    expect(countPackagesSection(content)).toEqual({ entries: 2, integrity: 1 });
  });

  it('counts a digest only on the resolution the entry pins', () => {
    const content = lockfile(
      ['  a@1.0.0:', '    resolution: {}', `    somethingElse: sha512-${digest('a')}`].join('\n'),
    );
    expect(countPackagesSection(content)).toEqual({ entries: 1, integrity: 0 });
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
