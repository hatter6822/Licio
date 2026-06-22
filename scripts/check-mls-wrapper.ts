// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.1a — the MLS-wrapper boundary gate.  `ts-mls` (the RFC 9420 MLS
// library) carries broad cryptographic authority, so it is reachable through
// exactly ONE reviewed wrapper, `packages/private-p2p/src/crypto/mls.ts`.  Every
// other module in the private-p2p plane MUST go through that wrapper surface, so
// the MLS implementation can be swapped (e.g. for an audited WASM build) without
// touching callers.  This gate fails if any file other than the wrapper imports
// `ts-mls` (a deep/direct import), defense-in-depth alongside the wrapper's own
// cipher-suite pin.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCAN_DIRS = [
  resolve(ROOT, 'packages/private-p2p/src'),
  resolve(ROOT, 'apps/web/src/private-p2p'),
];
/** The ONE file allowed to import the MLS library (POSIX-relative to the root). */
export const MLS_WRAPPER_PATH = 'packages/private-p2p/src/crypto/mls.ts';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);

// Any `import ... from 'ts-mls'` / `import 'ts-mls'` / `require('ts-mls')` /
// dynamic `import('ts-mls')`, including a deep subpath import `ts-mls/...`.
const TS_MLS_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]ts-mls(?:\/[^'"]*)?['"]/;

export interface ScanFile {
  /** A POSIX-style path relative to the repo root. */
  readonly path: string;
  readonly content: string;
}

/**
 * Pure scan: return every `(path, line)` outside the allowed wrapper that
 * imports `ts-mls`.  Testable with in-memory fixtures.
 */
export function scanMlsWrapperViolations(
  files: readonly ScanFile[],
  allowedPath: string = MLS_WRAPPER_PATH,
): Array<{ path: string; line: number }> {
  const violations: Array<{ path: string; line: number }> = [];
  for (const file of files) {
    if (file.path === allowedPath) continue;
    file.content.split('\n').forEach((line, i) => {
      if (TS_MLS_IMPORT.test(line)) violations.push({ path: file.path, line: i + 1 });
    });
  }
  return violations;
}

function collect(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) out.push(...collect(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main(): void {
  const files: ScanFile[] = SCAN_DIRS.flatMap(collect).map((abs) => ({
    path: relative(ROOT, abs).split('\\').join('/'),
    content: readFileSync(abs, 'utf-8'),
  }));
  const violations = scanMlsWrapperViolations(files);

  if (violations.length > 0) {
    console.error('check:p2p-mls-wrapper FAILED — ts-mls must be imported only via crypto/mls.ts:');
    for (const v of violations) console.error(`  - ${v.path}:${v.line}: deep import of 'ts-mls'`);
    process.exit(1);
  }
  console.log('check:p2p-mls-wrapper: OK (ts-mls is reached only through the reviewed wrapper)');
}

// Only run the file-system scan when invoked directly (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
