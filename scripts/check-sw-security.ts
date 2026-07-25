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
import {
  BUILT_CODE_SINKS,
  findDynamicCodeSinks,
  REMOTE_DYNAMIC_IMPORT_SINK,
  REMOTE_IMPORT_SCRIPTS_SINK,
} from './dangerous-code-patterns.js';

const DIST_DIR = resolve(import.meta.dirname, '..', 'apps', 'web', 'dist');
const SW_FILES = ['sw.js', 'sw-push.js'];

/** Find SW security violations in one file's source. Pure (testable). */
/** Find SW security violations in one file's source. Pure (testable). */
export function findSwSecurityIssues(filename: string, content: string): string[] {
  const issues: string[] = [];
  // Both checks go through the token analyzer, so every invocation form is
  // covered structurally: `importScripts('https://…')`,
  // `self['importScripts'](…)`, `self.importScripts?.(…)` and
  // `importScripts.call(self, …)` are one walk, not four patterns. Comments
  // are discarded while tokenising, so prose ("no remote code, no eval") can
  // never trip the gate and no comment-stripping pass is load-bearing.
  // A dynamic `import()` of a foreign URL loads remote code exactly as
  // `importScripts` does — a module worker can do it — so the same-origin
  // invariant this gate exists for covers both, from one shared definition.
  for (const { label, line } of findDynamicCodeSinks(content, [
    REMOTE_IMPORT_SCRIPTS_SINK,
    REMOTE_DYNAMIC_IMPORT_SINK,
  ])) {
    issues.push(`${filename}:${line}: ${label}`);
  }
  // Dynamic-code sinks from the shared definition: eval(), every
  // Function-constructor form, and the string-argument timers.
  const seen = new Set<string>();
  for (const { label } of findDynamicCodeSinks(content, BUILT_CODE_SINKS)) seen.add(label);
  for (const label of seen) issues.push(`${filename}: ${label} is forbidden in the worker`);
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
