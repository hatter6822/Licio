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
import { blankSourceComments } from './gate-comments.js';

const ROOT = resolve(import.meta.dirname, '..');
const WEB_SRC = resolve(ROOT, 'apps/web/src');
const SPECIFIER = '@licio/lcap-p2p';

/** Pure: the static-value-import violations in one source (importable for tests). */
export function findStaticP2pImports(filename: string, rawContent: string): string[] {
  // Blank comments through the PARSER, not a regex pair.  A regex has no notion
  // of a string literal, so a `/*` inside one opened a fake block comment that
  // swallowed every line up to the next real `*/` — and any JSDoc later in the
  // file supplies one.  A static `import … from '@licio/…-p2p'` sitting in the
  // swallowed span was invisible and the gate reported clean.  Blanking is
  // length- and newline-preserving, so the reported line still names the real one.
  const content = blankSourceComments(filename, rawContent);
  const issues: string[] = [];
  // Match `import … from '@licio/lcap-p2p'` and side-effect `import '@licio/lcap-p2p'`.
  const staticFrom = new RegExp(`\\bimport\\b([^;]*?)\\bfrom\\s*['"]${SPECIFIER}['"]`, 'g');
  const sideEffect = new RegExp(`\\bimport\\s*['"]${SPECIFIER}['"]`, 'g');
  // An aggregating re-export (`export { X } from '…'` / `export * from '…'`) is a STATIC binding
  // edge the bundler resolves synchronously exactly like `import`, so it must be caught too (a
  // re-export barrel would otherwise bypass the gate).  `export type …` is erased and permitted.
  const exportFrom = new RegExp(`\\bexport\\b([^;]*?)\\bfrom\\s*['"]${SPECIFIER}['"]`, 'g');
  for (const match of content.matchAll(staticFrom)) {
    // `import type …` is erased at build (no runtime weight) and is permitted.
    if (!/^\s*type\b/.test(match[1] ?? '')) {
      issues.push(`${filename}: static value import of ${SPECIFIER} (use a dynamic import())`);
    }
  }
  for (const match of content.matchAll(exportFrom)) {
    if (!/^\s*type\b/.test(match[1] ?? '')) {
      issues.push(`${filename}: static re-export of ${SPECIFIER} (use a dynamic import())`);
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
