// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LOCKFILE_PATH = resolve(ROOT, 'pnpm-lock.yaml');

const ALLOWED_HOSTS = new Set(['registry.npmjs.org']);

/**
 * A Subresource-Integrity value: an algorithm, then a BASE64 digest.
 *
 * The length is checked because the shortest algorithm pnpm emits is SHA-256,
 * whose base64 form is 44 characters — anything shorter is not a digest that
 * algorithm could have produced.
 */
const VALID_INTEGRITY =
  /integrity:\s*sha(?:256|384|512)-[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/;

/**
 * The `packages:` section's entry and integrity counts.
 *
 * Scoped by section rather than matched across the whole file: top-level keys
 * sit at column 0 and entries at two spaces, so the boundary is unambiguous,
 * and `snapshots:` — which repeats every package WITHOUT a resolution — cannot
 * inflate the denominator.
 */
export function countPackagesSection(content: string): { entries: number; integrity: number } {
  let entries = 0;
  let integrity = 0;
  let inside = false;
  for (const line of content.split('\n')) {
    if (/^[A-Za-z]/.test(line)) {
      inside = line.startsWith('packages:');
      continue;
    }
    if (!inside) continue;
    if (/^ {2}\S/.test(line)) entries += 1;
    // A DIGEST, not just the algorithm prefix.  Matching `sha512-` alone
    // accepted `integrity: sha512-` and `sha512-not!base64` as hashes, so a
    // lockfile with every digest emptied still reported full coverage — the
    // exact failure this check exists to notice.
    if (VALID_INTEGRITY.test(line)) integrity += 1;
  }
  return { entries, integrity };
}

function check(): void {
  const content = readFileSync(LOCKFILE_PATH, 'utf-8');
  const errors: string[] = [];
  let tarballCount = 0;

  const tarballPattern = /tarball:\s*(https?:\/\/[^\s'"]+)/g;
  for (const match of content.matchAll(tarballPattern)) {
    const url = match[1];
    if (!url) continue;
    tarballCount++;

    if (url.startsWith('http://')) {
      errors.push(`Non-HTTPS tarball URL found: ${url}`);
      continue;
    }

    try {
      const parsed = new URL(url);
      if (!ALLOWED_HOSTS.has(parsed.hostname)) {
        errors.push(`Unauthorized registry host: ${parsed.hostname} (URL: ${url.slice(0, 100)})`);
      }
    } catch {
      errors.push(`Unparseable tarball URL: ${url.slice(0, 100)}`);
    }
  }

  // EVERY resolved package carries an integrity hash — the exact property,
  // asked of the `packages:` section alone.
  //
  // It used to be a RATIO over every `name@version:` key in the file, and a
  // pnpm lockfile lists each package twice: once under `packages:` with its
  // resolution, and again under `snapshots:` with its dependency graph.  So the
  // denominator was always about double the numerator, the ratio always about
  // 0.5, and the threshold was `< 0.5` — meaning the check sat permanently on
  // its own boundary and passed or failed on rounding.  Adding two dependencies
  // moved it from 803/1606 (exactly 0.5, passing) to 805/1611 (0.4997,
  // failing), with integrity coverage a full 100% both times.
  const { entries: packageCount, integrity: integrityCount } = countPackagesSection(content);

  if (packageCount > 0 && integrityCount < packageCount) {
    errors.push(
      `${packageCount - integrityCount} of ${packageCount} packages have no integrity hash — ` +
        'every resolved package must carry one',
    );
  }

  if (errors.length > 0) {
    console.error('Lockfile validation FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `Lockfile validation passed: ${tarballCount} tarball URLs checked, all ${packageCount} packages carry an integrity hash.`,
  );
}

check();
