// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Service-worker security check (WS-C.2.1d, SPEC §25.2). Static analysis of the
// built service-worker output: no remote `importScripts` (external origin), no
// `eval`, and no `new Function`. A compromised worker could intercept signing
// requests, so locked scope + no remote code are mandatory. Run after the web
// build; the scanning core is pure and unit-tested.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_CODE_SINKS, stripComments } from './dangerous-code-patterns.js';

const DIST_DIR = resolve(import.meta.dirname, '..', 'apps', 'web', 'dist');
const SW_FILES = ['sw.js', 'sw-push.js'];

/** Find SW security violations in one file's source. Pure (testable). */
export function findSwSecurityIssues(filename: string, content: string): string[] {
  const code = stripComments(content);
  const issues: string[] = [];
  for (const call of code.match(/importScripts\s*\([^)]*\)/g) ?? []) {
    // Flag absolute (`https://…`) AND protocol-relative (`"//evil/x.js"`) remote
    // loads — both fetch cross-origin code; only same-origin/relative is allowed.
    if (/https?:\/\//i.test(call) || /['"]\s*\/\//.test(call)) {
      issues.push(`${filename}: external importScripts (remote code): ${call}`);
    }
  }
  // Dynamic-code sinks from the shared definition: eval(), BOTH
  // Function-constructor call forms, and the string-argument timers.
  for (const { pattern, label } of BUILT_CODE_SINKS) {
    if (pattern.test(code)) issues.push(`${filename}: ${label} is forbidden in the worker`);
  }
  return issues;
}

function main(): void {
  const errors: string[] = [];
  let scanned = 0;
  for (const file of SW_FILES) {
    const path = join(DIST_DIR, file);
    if (!existsSync(path)) {
      // sw.js must exist; sw-push.js is required too (imported by sw.js).
      errors.push(`Missing service-worker file: ${file} (run the web build first)`);
      continue;
    }
    scanned += 1;
    errors.push(...findSwSecurityIssues(file, readFileSync(path, 'utf-8')));
  }

  if (errors.length > 0) {
    console.error('Service-worker security check FAILED:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`Service-worker security check passed (${scanned} files: no remote code, no eval).`);
}

// Run as a CLI only; importing for tests must not trigger the dist scan.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
