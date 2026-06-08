// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LOCKFILE_PATH = resolve(ROOT, 'pnpm-lock.yaml');

const ALLOWED_HOSTS = new Set(['registry.npmjs.org']);

function check(): void {
  const content = readFileSync(LOCKFILE_PATH, 'utf-8');
  const errors: string[] = [];
  let tarballCount = 0;

  // In pnpm lockfiles, tarball URLs appear in "resolution:" blocks as "tarball:" values
  // and in the package path keys that reference registry URLs
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

  // Also check for integrity hashes existence
  const integrityPattern = /integrity:\s*(sha\d+-[A-Za-z0-9+/=]+)/g;
  let integrityCount = 0;
  for (const _match of content.matchAll(integrityPattern)) {
    integrityCount++;
  }

  if (errors.length > 0) {
    console.error('Lockfile validation FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `Lockfile validation passed: ${tarballCount} tarball URLs checked, ${integrityCount} integrity hashes present.`,
  );
}

check();
