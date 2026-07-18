// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bulk-advisory audit gate (the `pnpm audit` replacement after the
// registry retired the classic endpoint): the lockfile extraction must see
// every real package (scoped, peer-suffixed, quoted and unquoted keys, and
// NOT the snapshots/importers sections), and the severity filter must be
// fail-closed on unknown labels.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type BulkAdvisory, extractLockfilePackages, filterFindings } from '../audit-advisories.js';

const FIXTURE = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^6.0.3
        version: 6.0.3

packages:

  '@adobe/css-tools@4.5.0':
    resolution: {integrity: sha512-aaa}

  '@anthropic-ai/sdk@0.111.0':
    resolution: {integrity: sha512-bbb}
    peerDependencies:
      zod: ^3.25.0 || ^4.0.0

  zod@4.4.1:
    resolution: {integrity: sha512-ccc}

  ws@8.21.0:
    resolution: {integrity: sha512-ddd}

snapshots:

  'vitest@4.1.10(@types/node@22.10.2)(jsdom@29.1.1)':
    dependencies:
      zod: 4.4.1
`;

describe('audit-advisories (the bulk-endpoint pnpm-audit replacement)', () => {
  it('extracts scoped and unscoped packages and ignores importers/snapshots', () => {
    const packages = extractLockfilePackages(FIXTURE);
    expect([...packages.keys()].sort()).toEqual([
      '@adobe/css-tools',
      '@anthropic-ai/sdk',
      'ws',
      'zod',
    ]);
    expect([...(packages.get('@anthropic-ai/sdk') ?? [])]).toEqual(['0.111.0']);
    expect([...(packages.get('zod') ?? [])]).toEqual(['4.4.1']);
    // The peer-suffixed snapshot key never leaks a 'vitest' entry from the
    // snapshots section, and the importer specifier never becomes a package.
    expect(packages.has('vitest')).toBe(false);
    expect(packages.has('typescript')).toBe(false);
  });

  it('extracts the REAL lockfile with near-full integrity-count parity', () => {
    const lockfile = readFileSync(resolve(import.meta.dirname, '../../pnpm-lock.yaml'), 'utf-8');
    const packages = extractLockfilePackages(lockfile);
    const versionCount = [...packages.values()].reduce((sum, set) => sum + set.size, 0);
    const integrityCount = [...lockfile.matchAll(/resolution: \{integrity:/g)].length;
    // Every packages-section entry carries a resolution line; the extraction
    // must account for essentially all of them (a silent under-extraction
    // would silently shrink the audit surface).
    expect(versionCount).toBeGreaterThanOrEqual(integrityCount * 0.99);
    expect(packages.size).toBeGreaterThan(100);
  });

  it('filters at the threshold and treats unknown severities as findings (fail-closed)', () => {
    const advisory = (severity: string): BulkAdvisory => ({
      id: 1,
      url: 'https://github.com/advisories/GHSA-test',
      title: 'fixture advisory',
      severity,
      vulnerable_versions: '<9.9.9',
    });
    const posted = new Map([['left-pad', new Set(['1.0.0'])]]);
    const response = {
      'left-pad': [advisory('moderate'), advisory('high'), advisory('nonsense')],
    };
    const highAndUp = filterFindings(response, posted, 'high');
    expect(highAndUp.map((f) => f.advisory.severity).sort()).toEqual(['high', 'nonsense']);
    expect(highAndUp[0]?.versions).toEqual(['1.0.0']);
    const all = filterFindings(response, posted, 'low');
    expect(all).toHaveLength(3);
  });
});
