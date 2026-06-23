// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.8 — the transport code-split gate.  @licio/lcap-p2p (WebRTC + the IPFS
// bridge) is an OPTIONAL, off-by-default transport package.  Its protocol code MUST
// stay out of the apps/web initial bundle, so apps/web may reference it ONLY through a
// DYNAMIC `import('@licio/lcap-p2p')` (a lazy chunk) — never a static VALUE import that
// would pull it onto the synchronous path.  A bare `import type … from '@licio/lcap-p2p'`
// is erased at build and is allowed.  This gate fails the build on a static value import
// in apps/web/src (the "deliberately mis-placed import fails a gate" acceptance check).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WEB_SRC = resolve(ROOT, 'apps/web/src');
const SPECIFIER = '@licio/lcap-p2p';

/** Strip block + line comments so the word "import" inside a comment cannot
 *  falsely pair with a later `from '…'` across newlines (the `[^;]*?` capture
 *  spans newlines for multi-line imports).  The `[^:]` guard preserves `://`. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Pure: the static-value-import violations in one source (importable for tests). */
export function findStaticP2pImports(filename: string, rawContent: string): string[] {
  const content = stripComments(rawContent);
  const issues: string[] = [];
  // Match `import … from '@licio/lcap-p2p'` and side-effect `import '@licio/lcap-p2p'`.
  const staticFrom = new RegExp(`\\bimport\\b([^;]*?)\\bfrom\\s*['"]${SPECIFIER}['"]`, 'g');
  const sideEffect = new RegExp(`\\bimport\\s*['"]${SPECIFIER}['"]`, 'g');
  for (const match of content.matchAll(staticFrom)) {
    // `import type …` is erased at build (no runtime weight) and is permitted.
    if (!/^\s*type\b/.test(match[1] ?? '')) {
      issues.push(`${filename}: static value import of ${SPECIFIER} (use a dynamic import())`);
    }
  }
  if (sideEffect.test(content)) {
    issues.push(`${filename}: side-effect import of ${SPECIFIER} (use a dynamic import())`);
  }
  return issues;
}

function collect(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') out.push(...collect(full));
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main(): void {
  const errors: string[] = [];
  for (const file of collect(WEB_SRC)) {
    errors.push(...findStaticP2pImports(file.replace(ROOT, ''), readFileSync(file, 'utf-8')));
  }
  if (errors.length > 0) {
    console.error('check:lcap-p2p-split FAILED — @licio/lcap-p2p must be dynamically imported:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    'check:lcap-p2p-split passed: apps/web references @licio/lcap-p2p only via dynamic import.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
